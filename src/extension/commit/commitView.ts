import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommitFile, CommitHostMessage, CommitWebviewMessage } from '../../shared/commitProtocol';
import type { ChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import { workingFileUri } from '../content/revisionUri';
import { WORKTREE, type Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import { renderHtml, webviewOptions } from '../webviewHtml';

const VIEW_TYPE = 'grove.commit';
const REFRESH_DELAY_MS = 500;

/** Rider's Commit tool window: changes with checkboxes, amend, message, commit and push, stashes. */
export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private repository?: Repository;
  private files: CommitFile[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repositories: RepositoryManager,
    private readonly navigator: ChangeSetNavigator,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const refresh = () => this.scheduleRefresh();
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(VIEW_TYPE, this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      watcher,
      watcher.onDidChange(refresh),
      watcher.onDidCreate(refresh),
      watcher.onDidDelete(refresh),
      vscode.workspace.onDidSaveTextDocument(refresh),
      repositories.onDidChangeRepository(refresh),
      repositories.onDidChangeRepositories(refresh),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.context.extensionUri);
    view.webview.html = renderHtml(view.webview, this.context.extensionUri, 'commit');
    view.webview.onDidReceiveMessage((message: CommitWebviewMessage) => this.handle(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.scheduleRefresh();
    });
    view.onDidDispose(() => (this.view = undefined));
  }

  private async handle(message: CommitWebviewMessage): Promise<void> {
    try {
      await this.dispatch(message);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Git: ${text}`);
    }
  }

  private async dispatch(message: CommitWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
      case 'refresh':
        return this.refresh();
      case 'openDiff':
        return this.openDiff(message.path);
      case 'openFile': {
        const repository = this.repository;
        if (repository) await vscode.window.showTextDocument(workingFileUri(repository.root, message.path));
        return;
      }
      case 'rollback':
        return this.rollback(message.paths);
      case 'commit':
        return this.commit(message);
      case 'requestAmendMessage':
        if (this.repository)
          this.post({ type: 'amendMessage', message: await this.repository.lastCommitMessage() });
        return;
      case 'requestRecentMessages':
        if (this.repository)
          this.post({ type: 'recentMessages', messages: await this.repository.recentMessages() });
        return;
      case 'stashSave':
        return this.stashSave(message.message, message.includeUntracked);
      case 'stashAction':
        return this.stashAction(message.action, message.selector, message.hash);
    }
  }

  /** File events come in thousands during a build, so a hidden view refreshes only when it is shown again. */
  private scheduleRefresh(): void {
    if (!this.view?.visible) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_DELAY_MS);
  }

  private async refresh(): Promise<void> {
    this.repository ??= this.repositories.all[0];
    const repository = this.repository;
    if (!repository) {
      this.post({ type: 'noRepository' });
      return;
    }
    const [changes, stashes, head] = await Promise.all([
      repository.workingChanges(),
      repository.stashes(),
      repository.head(),
    ]);
    const conflicted = new Set(changes.conflicted);
    this.files = [
      ...changes.conflicted.map((p): CommitFile => ({ path: p, status: 'U', kind: 'conflict' })),
      ...changes.tracked
        .filter((c) => !conflicted.has(c.path))
        .map((c): CommitFile => ({ path: c.path, oldPath: c.oldPath, status: c.status, kind: 'tracked' })),
      ...changes.untracked.map((p): CommitFile => ({ path: p, status: '?', kind: 'untracked' })),
    ];
    this.post({ type: 'state', branch: head.branch, files: this.files, stashes });
  }

  /** Every change of the working copy is one change set, so the diff arrows walk through all of them. */
  private async openDiff(filePath: string): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    const files = this.files
      .filter((f) => f.kind !== 'conflict')
      .map((f) => ({
        status: f.kind === 'untracked' ? ('A' as const) : (f.status as Exclude<CommitFile['status'], '?'>),
        path: f.path,
        oldPath: f.oldPath,
      }));
    const index = files.findIndex((f) => f.path === filePath);
    if (index < 0) {
      await vscode.window.showTextDocument(workingFileUri(repository.root, filePath));
      return;
    }
    const changeSet: ChangeSet = {
      repository,
      title: 'Локальные изменения',
      left: 'HEAD',
      right: WORKTREE,
      files,
    };
    await this.navigator.open(changeSet, index);
  }

  private async rollback(paths: string[]): Promise<void> {
    const repository = this.repository;
    if (!repository || paths.length === 0) return;
    const selected = this.files.filter((f) => paths.includes(f.path));
    const untracked = selected.filter((f) => f.kind === 'untracked');
    const tracked = selected.filter((f) => f.kind !== 'untracked');
    const detail = [
      tracked.length ? `Изменения в ${tracked.length} файл(ах) будут отменены.` : '',
      untracked.length ? `${untracked.length} неотслеживаемых файл(ов) уйдут в корзину.` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const names =
      selected.length <= 5
        ? selected.map((f) => path.basename(f.path)).join(', ')
        : `${selected.length} файлов`;
    const ok = await vscode.window.showWarningMessage(
      `Откатить ${names}?`,
      { modal: true, detail },
      'Откатить',
    );
    if (!ok) return;
    await repository.rollback(tracked.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])));
    for (const file of untracked) {
      await vscode.workspace.fs.delete(workingFileUri(repository.root, file.path), {
        recursive: true,
        useTrash: true,
      });
    }
    await this.refresh();
  }

  private async commit(message: {
    message: string;
    paths: string[];
    amend: boolean;
    push: boolean;
  }): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    if (this.files.some((f) => f.kind === 'conflict')) {
      void vscode.window.showWarningMessage('Сначала разрешите конфликты.');
      return;
    }
    if (!message.message.trim()) {
      void vscode.window.showWarningMessage('Введите сообщение коммита.');
      return;
    }
    const selected = this.files.filter((f) => message.paths.includes(f.path));
    if (selected.length === 0 && !message.amend) {
      void vscode.window.showWarningMessage('Отметьте файлы для коммита.');
      return;
    }
    this.post({ type: 'busy', value: true });
    try {
      await repository.commitFiles({
        message: message.message,
        paths: selected
          .filter((f) => f.kind === 'tracked')
          .flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])),
        untracked: selected.filter((f) => f.kind === 'untracked').map((f) => f.path),
        amend: message.amend,
      });
      this.post({ type: 'committed' });
      this.repositories.notifyChanged(repository);
      vscode.window.setStatusBarMessage(`Grove: закоммичено ${selected.length} файл(ов)`, 4000);
      if (message.push) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Grove: push' },
          () => repository.push(),
        );
        this.repositories.notifyChanged(repository);
      }
    } finally {
      this.post({ type: 'busy', value: false });
      await this.refresh();
    }
  }

  private async stashSave(message: string, includeUntracked: boolean): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    await repository.stashSave(message, includeUntracked);
    this.repositories.notifyChanged(repository);
    await this.refresh();
  }

  private async stashAction(
    action: 'show' | 'apply' | 'pop' | 'drop',
    selector: string,
    hash: string,
  ): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    switch (action) {
      case 'show': {
        const details = await repository.commitDetails(hash);
        const files = await repository.changes(details.parents[0], hash);
        if (files.length) {
          await this.navigator.open(
            { repository, title: selector, left: details.parents[0], right: hash, files },
            0,
          );
        }
        return;
      }
      case 'apply':
      case 'pop':
        await repository.stashApply(selector, action === 'pop');
        break;
      case 'drop': {
        const ok = await vscode.window.showWarningMessage(
          `Удалить ${selector}?`,
          { modal: true, detail: 'Спрятанные изменения пропадут.' },
          'Удалить',
        );
        if (!ok) return;
        await repository.stashDrop(selector);
        break;
      }
    }
    this.repositories.notifyChanged(repository);
    await this.refresh();
  }

  private post(message: CommitHostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }
}
