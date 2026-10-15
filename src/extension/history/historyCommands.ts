import * as path from 'node:path';
import * as vscode from 'vscode';
import { commitChangeSet, type ChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import { parseRevisionUri, REVISION_SCHEME } from '../content/revisionUri';
import { WORKTREE, type Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import type { LogWebviews } from '../log/logWebview';
import { t } from '../../shared/l10n';

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
      vscode.commands.registerCommand('kleio.history.folder', (uri?: vscode.Uri) => this.folderHistory(uri)),
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
    this.logs.openHistory({ ...target, title: t('History: {0}', path.basename(target.path)) });
  }

  private async folderHistory(uri?: vscode.Uri): Promise<void> {
    const target = await this.targetFor(uri);
    if (!target) return;
    const name = target.path ? path.basename(target.path) : target.repository.name;
    this.logs.openHistory({ ...target, folder: true, title: t('History: {0}/', name) });
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
    const lines = start === end ? t('line {0}', start) : t('lines {0}–{1}', start, end);
    this.logs.openHistory({
      ...target,
      range: { start, end },
      title: t('History: {0}, {1}', path.basename(target.path), lines),
    });
  }

  private async compareWithRevision(uri?: vscode.Uri): Promise<void> {
    const target = await this.targetFor(uri ?? vscode.window.activeTextEditor?.document.uri);
    if (!target) return;
    const { repository } = target;
    const refs = await repository.refs();
    const items: (vscode.QuickPickItem & { revision?: string })[] = [
      {
        label: `$(edit) ${t('Another revision…')}`,
        description: t('hash, tag or git expression'),
        revision: undefined,
      },
      ...refs
        .filter((r) => r.kind !== 'tag')
        .map((r) => ({
          label: `${r.kind === 'remote' ? '$(cloud)' : '$(git-branch)'} ${r.name}`,
          revision: r.name,
        })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Compare {0} with…', path.basename(target.path)),
      placeHolder: t('Branch or revision'),
      matchOnDescription: true,
    });
    if (!picked) return;
    const revision =
      picked.revision ??
      (await vscode.window.showInputBox({
        title: t('Revision to compare with'),
        prompt: t('Hash, tag, HEAD~3 and so on'),
      }));
    if (!revision) return;
    if (!(await repository.revParse(revision))) {
      void vscode.window.showWarningMessage(t('Revision {0} is not found.', revision));
      return;
    }
    const changeSet: ChangeSet = {
      repository,
      title: t('{0} ↔ working tree', revision),
      left: revision,
      right: WORKTREE,
      files: [{ status: 'M', path: target.path }],
    };
    await this.navigator.open(changeSet, 0);
  }

  private async targetFor(uri: vscode.Uri | undefined): Promise<FileTarget | undefined> {
    if (!uri) {
      void vscode.window.showInformationMessage(t('Open a file to see its history.'));
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
      void vscode.window.showWarningMessage(t('The file is not in a git repository.'));
      return undefined;
    }
    return { repository, path: path.relative(repository.root, uri.fsPath).split(path.sep).join('/') };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
