import * as path from 'node:path';
import * as vscode from 'vscode';
import { commitChangeSet, type ChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import { parseRevisionUri, REVISION_SCHEME } from '../content/revisionUri';
import { WORKTREE, type Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import type { LogWebviews } from '../log/logWebview';

interface FileTarget {
  repository: Repository;
  path: string;
}

/** File history, history of selected lines and comparing a file with another revision. */
export class HistoryCommands implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly repositories: RepositoryManager,
    private readonly logs: LogWebviews,
    private readonly navigator: ChangeSetNavigator,
  ) {
    this.disposables = [
      vscode.commands.registerCommand('kleio.history.file', (uri?: vscode.Uri) => this.fileHistory(uri)),
      vscode.commands.registerCommand('kleio.history.selection', () => this.selectionHistory()),
      vscode.commands.registerCommand('kleio.compare.withRevision', (uri?: vscode.Uri) =>
        this.compareWithRevision(uri),
      ),
    ];
  }

  /** Opens the diff of one file in a commit, with the rest of the commit a step away in the same viewer. */
  async showCommitFile(repository: Repository, hash: string, filePath: string): Promise<void> {
    const details = await repository.commitDetails(hash);
    const changeSet = await commitChangeSet(repository, hash, details.parents);
    const index = changeSet.files.findIndex((f) => f.path === filePath || f.oldPath === filePath);
    await this.navigator.open(changeSet, Math.max(0, index));
  }

  private async fileHistory(uri?: vscode.Uri): Promise<void> {
    const target = await this.targetFor(uri ?? vscode.window.activeTextEditor?.document.uri);
    if (!target) return;
    this.logs.openHistory({ ...target, title: `История: ${path.basename(target.path)}` });
  }

  private async selectionHistory(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const target = await this.targetFor(editor.document.uri);
    if (!target) return;
    const selection = editor.selection;
    const start = selection.start.line + 1;
    // A selection ending at the start of a line does not include that line.
    const end = Math.max(
      start,
      selection.end.character === 0 && selection.end.line > selection.start.line
        ? selection.end.line
        : selection.end.line + 1,
    );
    const lines = start === end ? `строка ${start}` : `строки ${start}–${end}`;
    this.logs.openHistory({
      ...target,
      range: { start, end },
      title: `История: ${path.basename(target.path)}, ${lines}`,
    });
  }

  private async compareWithRevision(uri?: vscode.Uri): Promise<void> {
    const target = await this.targetFor(uri ?? vscode.window.activeTextEditor?.document.uri);
    if (!target) return;
    const { repository } = target;
    const refs = await repository.refs();
    const items: (vscode.QuickPickItem & { revision?: string })[] = [
      { label: '$(edit) Другая ревизия…', description: 'хэш, тег или выражение git', revision: undefined },
      ...refs
        .filter((r) => r.kind !== 'tag')
        .map((r) => ({
          label: `${r.kind === 'remote' ? '$(cloud)' : '$(git-branch)'} ${r.name}`,
          revision: r.name,
        })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `Сравнить ${path.basename(target.path)} с…`,
      placeHolder: 'Ветка или ревизия',
      matchOnDescription: true,
    });
    if (!picked) return;
    const revision =
      picked.revision ??
      (await vscode.window.showInputBox({
        title: 'Ревизия для сравнения',
        prompt: 'Хэш, тег, HEAD~3 и т. п.',
      }));
    if (!revision) return;
    if (!(await repository.revParse(revision))) {
      void vscode.window.showWarningMessage(`Ревизия ${revision} не найдена.`);
      return;
    }
    const changeSet: ChangeSet = {
      repository,
      title: `${revision} ↔ рабочая копия`,
      left: revision,
      right: WORKTREE,
      files: [{ status: 'M', path: target.path }],
    };
    await this.navigator.open(changeSet, 0);
  }

  private async targetFor(uri: vscode.Uri | undefined): Promise<FileTarget | undefined> {
    if (!uri) {
      void vscode.window.showInformationMessage('Откройте файл, чтобы посмотреть его историю.');
      return undefined;
    }
    if (uri.scheme === REVISION_SCHEME) {
      const { root, path: filePath } = parseRevisionUri(uri);
      const repository = await this.repositories.get(root);
      return repository ? { repository, path: filePath } : undefined;
    }
    const repository =
      this.repositories.repositoryFor(uri) ?? (await this.repositories.get(path.dirname(uri.fsPath)));
    if (!repository) {
      void vscode.window.showWarningMessage('Файл не в git-репозитории.');
      return undefined;
    }
    return { repository, path: path.relative(repository.root, uri.fsPath).split(path.sep).join('/') };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
