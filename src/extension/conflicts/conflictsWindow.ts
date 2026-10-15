import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  ConflictFileView,
  ConflictSides,
  ConflictsHostMessage,
  ConflictsWebviewMessage,
} from '../../shared/conflictsProtocol';
import type { OperationState } from '../../shared/model';
import type { SyncActions } from '../actions/syncActions';
import { emptyUri, revisionUri, workingFileUri } from '../content/revisionUri';
import type { Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import { renderHtml, webviewOptions } from '../webviewHtml';

const PANEL_TYPE = 'kleio.conflicts';
const MARKERS = /^(<{7}|>{7}) /m;

const operationNames = {
  merge: 'merge',
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
} as const;

/**
 * Rider's conflicts dialog: the conflicted files with "take ours / take theirs" and a three-way merge in the
 * built-in merge editor. A file saved without conflict markers is marked as resolved, as Rider's "Apply" does.
 */
export class ConflictsWindow implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private repository?: Repository;
  private files: ConflictFileView[] = [];
  private sides: ConflictSides = { ours: 'ours', theirs: 'theirs' };
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repositories: RepositoryManager,
    private readonly sync: SyncActions,
  ) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => void this.resolveSaved(document)),
      repositories.onDidChangeRepository((repository) => {
        if (repository === this.repository && this.panel) void this.load();
      }),
      vscode.commands.registerCommand('kleio.conflicts.show', async () => {
        const repository = this.repository ?? repositories.all[0];
        if (repository) await this.open(repository);
      }),
      vscode.commands.registerCommand('kleio.conflicts.markResolved', () => this.markActiveResolved()),
    );
  }

  async open(repository: Repository): Promise<void> {
    this.repository = repository;
    if (this.panel) {
      this.panel.reveal();
      await this.load();
      return;
    }
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, 'Конфликты', vscode.ViewColumn.Active, {
      ...webviewOptions(this.context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.webview.html = renderHtml(panel.webview, this.context.extensionUri, 'conflicts');
    panel.webview.onDidReceiveMessage((message: ConflictsWebviewMessage) => void this.handle(message));
    panel.onDidDispose(() => (this.panel = undefined));
    this.panel = panel;
  }

  /** Opens the three-way merge of a conflicted file: ours on the left, theirs on the right, the result below. */
  async openMerge(repository: Repository, filePath: string): Promise<void> {
    const file = (await repository.conflicts()).find((f) => f.path === filePath);
    const output = workingFileUri(repository.root, filePath);
    if (!file || !file.ours || !file.theirs) {
      // A file deleted on one side has nothing to merge line by line.
      await vscode.window.showTextDocument(output);
      return;
    }
    const sides = await this.describeSides(repository, await repository.operation());
    const side = (stage: string, title: string, detail: string) => ({
      uri: revisionUri(repository.root, stage, filePath),
      title,
      description: '',
      detail,
    });
    try {
      await vscode.commands.executeCommand('_open.mergeEditor', {
        base: file.base ? revisionUri(repository.root, ':1', filePath) : emptyUri(repository.root, filePath),
        input1: side(':2', sides.ours, 'ours'),
        input2: side(':3', sides.theirs, 'theirs'),
        output,
      });
    } catch {
      await vscode.window.showTextDocument(output);
    }
  }

  private async handle(message: ConflictsWebviewMessage): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    try {
      switch (message.type) {
        case 'ready':
          return await this.load();
        case 'merge':
          return await this.openMerge(repository, message.path);
        case 'resolve': {
          const files = this.files.filter((f) => message.paths.includes(f.path));
          this.post({ type: 'busy', value: true });
          try {
            await repository.resolveConflicts(files, message.side);
          } finally {
            this.post({ type: 'busy', value: false });
          }
          this.repositories.notifyChanged(repository);
          return await this.load();
        }
        case 'operation': {
          const state = await repository.operation();
          if (!state) return await this.load();
          if (message.action === 'abort') await this.sync.abort(repository, state.kind);
          else await this.sync.continueOperation(repository, state.kind);
          return await this.load();
        }
        case 'close':
          this.panel?.dispose();
          return;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Git: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async load(): Promise<void> {
    const repository = this.repository;
    if (!repository || !this.panel) return;
    const [files, state] = await Promise.all([repository.conflicts(), repository.operation()]);
    this.files = files;
    this.sides = await this.describeSides(repository, state);
    this.post({
      type: 'state',
      operation: state?.kind,
      title: state ? await this.describeOperation(repository, state) : 'Нет идущей операции',
      sides: this.sides,
      files,
    });
  }

  /** Marks a conflicted file resolved once it is saved without conflict markers. */
  private async resolveSaved(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') return;
    // The merge editor keeps unhandled conflicts as the base text, without markers: its result is resolved
    // only by "Complete Merge".
    if (mergeEditorResults().some((uri) => uri.toString() === document.uri.toString())) return;
    const repository = this.repositories.repositoryFor(document.uri);
    if (!repository) return;
    const relative = path.relative(repository.root, document.uri.fsPath).split(path.sep).join('/');
    const state = await repository.operation();
    if (!state?.conflicted.includes(relative) || MARKERS.test(document.getText())) return;
    await repository.markResolved([relative]);
    this.repositories.notifyChanged(repository);
    const left = state.conflicted.length - 1;
    if (left > 0) {
      vscode.window.setStatusBarMessage(`Kleio: ${relative} — конфликт разрешён, осталось ${left}`, 5000);
    } else {
      this.offerToContinue(repository, state.kind);
    }
    if (this.panel && repository === this.repository) await this.load();
  }

  /** "Mark as resolved" in the title of the merge editor, for a result saved earlier or kept as is. */
  /**
   * "Complete merge" in the merge editor: its own command asks about unhandled conflicts, saves and closes;
   * then the file is marked resolved. In a plain editor the file is saved and marked, with a warning about
   * markers left in it.
   */
  private async markActiveResolved(): Promise<void> {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { result?: unknown } | undefined;
    const merging = input?.result instanceof vscode.Uri ? input.result : undefined;
    const uri = merging ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') return;
    const repository = this.repositories.repositoryFor(uri);
    if (!repository) return;
    if (merging) {
      const outcome = await vscode.commands.executeCommand<{ successful?: boolean } | undefined>(
        'mergeEditor.acceptMerge',
      );
      if (outcome?.successful === false) return;
    } else {
      const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (document?.isDirty) await document.save();
    }
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    if (MARKERS.test(text)) {
      const ok = await vscode.window.showWarningMessage(
        'В файле остались маркеры конфликта. Всё равно отметить как разрешённый?',
        { modal: true },
        'Отметить',
      );
      if (!ok) return;
    }
    const relative = path.relative(repository.root, uri.fsPath).split(path.sep).join('/');
    await repository.markResolved([relative]);
    this.repositories.notifyChanged(repository);
    if (!merging) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const left = (await repository.conflicts()).length;
    const state = await repository.operation();
    if (left === 0 && state) {
      this.offerToContinue(repository, state.kind);
    } else {
      vscode.window.setStatusBarMessage(`Kleio: ${relative} — конфликт разрешён, осталось ${left}`, 5000);
    }
    if (this.panel && repository === this.repository) await this.load();
  }

  /** Offers to go on once no conflicts are left; not awaited, so the command that resolved them returns. */
  private offerToContinue(repository: Repository, kind: OperationState['kind']): void {
    const next = `Продолжить ${operationNames[kind]}`;
    void vscode.window.showInformationMessage('Все конфликты разрешены.', next).then(async (choice) => {
      if (choice === next) await this.sync.continueOperation(repository, kind);
    });
  }

  private async describeSides(
    repository: Repository,
    state: OperationState | undefined,
  ): Promise<ConflictSides> {
    const head = await repository.head();
    const current = head.branch ?? 'HEAD';
    if (!state) return { ours: current, theirs: 'theirs' };
    const onto = await this.name(repository, state.onto);
    switch (state.kind) {
      case 'merge':
        return { ours: current, theirs: onto };
      case 'rebase': {
        if (!state.stoppedAt)
          return { ours: `${onto} (база rebase)`, theirs: state.branch ?? 'применяемый коммит' };
        const applied = await this.commit(repository, state.stoppedAt);
        // A subject usually starts with the ticket the branch is named after; the branch is not repeated then.
        const branch = state.branch && !applied.includes(state.branch) ? `${state.branch} · ` : '';
        return { ours: `${onto} (база rebase)`, theirs: `${branch}${applied}` };
      }
      case 'cherry-pick':
      case 'revert':
        return { ours: current, theirs: state.onto ? await this.commit(repository, state.onto) : 'коммит' };
    }
  }

  private async describeOperation(repository: Repository, state: OperationState): Promise<string> {
    const onto = await this.name(repository, state.onto);
    switch (state.kind) {
      case 'rebase': {
        const step = state.step && state.total ? ` · шаг ${state.step} из ${state.total}` : '';
        return `Rebase ${state.branch ?? 'HEAD'} на ${onto}${step}`;
      }
      case 'merge':
        return `Merge ${onto} в ${(await repository.head()).branch ?? 'HEAD'}`;
      case 'cherry-pick':
        return `Cherry-pick ${onto}`;
      case 'revert':
        return `Revert ${onto}`;
    }
  }

  /** A local or remote branch at the commit, or its short hash. */
  private async name(repository: Repository, hash: string | undefined): Promise<string> {
    if (!hash) return '?';
    const refs = (await repository.refs()).filter((r) => r.hash === hash);
    const ref = refs.find((r) => r.kind === 'head') ?? refs.find((r) => r.kind === 'remote') ?? refs[0];
    return ref?.name ?? hash.slice(0, 8);
  }

  private async commit(repository: Repository, hash: string): Promise<string> {
    const details = await repository.commitDetails(hash);
    const subject = details.message.split('\n')[0];
    return `${hash.slice(0, 8)} ${subject.length > 40 ? subject.slice(0, 39) + '…' : subject}`;
  }

  private post(message: ConflictsHostMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** Result files of the merge editors that are open; their input type is not in the stable API yet. */
function mergeEditorResults(): vscode.Uri[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map((tab) => (tab.input as { result?: unknown } | undefined)?.result)
    .filter((uri): uri is vscode.Uri => uri instanceof vscode.Uri);
}
