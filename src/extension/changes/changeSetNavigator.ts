import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../../shared/model';
import type { Hunk } from '../git/parse';
import { WORKTREE } from '../git/repository';
import { emptyUri, revisionUri, workingFileUri } from '../content/revisionUri';
import { describeRange, shortRevision, type ChangeSet } from './changeSet';

interface OpenedFile {
  changeSet: ChangeSet;
  index: number;
  left: vscode.Uri;
  right: vscode.Uri;
  hunks: Hunk[];
}

type Edge = 'first' | 'last';

const CONTEXT_KEY = 'grove.inChangeSet';

/**
 * Rider-style diff viewer on top of the built-in diff editor: one file of a change set at a time,
 * "next difference" continues into the next file when the current one has no more changes.
 */
export class ChangeSetNavigator implements vscode.Disposable {
  private current?: OpenedFile;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateContext()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.commands.registerCommand('grove.diff.nextChange', () => this.moveChange(1)),
      vscode.commands.registerCommand('grove.diff.previousChange', () => this.moveChange(-1)),
      vscode.commands.registerCommand('grove.diff.nextFile', () => this.moveFile(1)),
      vscode.commands.registerCommand('grove.diff.previousFile', () => this.moveFile(-1)),
      vscode.commands.registerCommand('grove.diff.selectFile', () => this.selectFile()),
      vscode.commands.registerCommand('grove.diff.openCurrent', () => this.openCurrentFromDiff()),
    );
  }

  async open(changeSet: ChangeSet, index: number, edge: Edge = 'first'): Promise<void> {
    const change = changeSet.files[index];
    if (!change) return;
    const { repository, left, right } = changeSet;
    const root = repository.root;

    const leftUri =
      change.status === 'A' || left === undefined
        ? emptyUri(root, change.path)
        : revisionUri(root, left, change.oldPath ?? change.path);
    const rightUri =
      change.status === 'D' ? emptyUri(root, change.path) : await this.rightSideUri(changeSet, change);
    const hunks = await repository.hunks(left, right, change).catch(() => []);

    this.current = { changeSet, index, left: leftUri, right: rightUri, hunks };
    const target = edge === 'first' ? hunks[0] : hunks[hunks.length - 1];
    const line = target ? hunkLine(target, 'right') : 0;
    const title = `${path.basename(change.path)} (${describeRange(changeSet)}) — ${index + 1}/${changeSet.files.length}`;
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
      preview: true,
      selection: new vscode.Range(line, 0, line, 0),
    } satisfies vscode.TextDocumentShowOptions);
    this.updateContext();
  }

  async openCurrent(changeSet: ChangeSet, index: number, line = 0): Promise<void> {
    const change = changeSet.files[index];
    if (!change) return;
    const uri = workingFileUri(changeSet.repository.root, change.path);
    if (!fs.existsSync(uri.fsPath)) {
      void vscode.window.showWarningMessage(`Файла ${change.path} нет в рабочей копии.`);
      return;
    }
    await vscode.window.showTextDocument(uri, {
      preview: false,
      selection: new vscode.Range(line, 0, line, 0),
    });
  }

  async openRevision(changeSet: ChangeSet, index: number): Promise<void> {
    const change = changeSet.files[index];
    if (!change) return;
    const deleted = change.status === 'D';
    const revision = deleted ? changeSet.left : changeSet.right;
    if (revision === undefined) return;
    const filePath = deleted ? (change.oldPath ?? change.path) : change.path;
    const uri =
      revision === WORKTREE
        ? workingFileUri(changeSet.repository.root, filePath)
        : revisionUri(changeSet.repository.root, revision, filePath);
    await vscode.window.showTextDocument(uri, { preview: true });
  }

  async compareWithWorktree(changeSet: ChangeSet, index: number): Promise<void> {
    const change = changeSet.files[index];
    if (!change || changeSet.right === WORKTREE) return;
    const root = changeSet.repository.root;
    const left =
      change.status === 'D'
        ? revisionUri(root, changeSet.left ?? '', change.oldPath ?? change.path)
        : revisionUri(root, changeSet.right, change.path);
    const right = workingFileUri(root, change.path);
    const title = `${path.basename(change.path)} (${shortRevision(changeSet.right)} ↔ рабочая копия)`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  /**
   * A revision identical to the file on disk is shown as the real file: it stays editable and language
   * servers work in it, as in Rider.
   */
  private async rightSideUri(changeSet: ChangeSet, change: FileChange): Promise<vscode.Uri> {
    const { repository, right } = changeSet;
    const working = workingFileUri(repository.root, change.path);
    if (right === WORKTREE) return working;
    const [revisionBlob, workingBlob] = await Promise.all([
      repository.blobHash(right, change.path),
      repository.worktreeBlobHash(change.path),
    ]);
    return revisionBlob && revisionBlob === workingBlob
      ? working
      : revisionUri(repository.root, right, change.path);
  }

  private async moveChange(direction: 1 | -1): Promise<void> {
    const current = this.current;
    const editor = vscode.window.activeTextEditor;
    if (!current || !editor || !this.isShowingCurrent()) return;

    const side = editor.document.uri.toString() === current.left.toString() ? 'left' : 'right';
    const cursor = editor.selection.active.line;
    const lines = current.hunks.map((h) => clampLine(hunkLine(h, side), editor.document));
    const next =
      direction === 1 ? lines.find((l) => l > cursor) : [...lines].reverse().find((l) => l < cursor);

    if (next !== undefined) {
      editor.selection = new vscode.Selection(next, 0, next, 0);
      editor.revealRange(
        new vscode.Range(next, 0, next, 0),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
      return;
    }
    await this.moveFile(direction);
  }

  private async moveFile(direction: 1 | -1): Promise<void> {
    const current = this.current;
    if (!current) return;
    const index = current.index + direction;
    if (index < 0 || index >= current.changeSet.files.length) {
      vscode.window.setStatusBarMessage(
        direction === 1 ? 'Grove: это последнее изменение набора' : 'Grove: это первое изменение набора',
        3000,
      );
      return;
    }
    await this.open(current.changeSet, index, direction === 1 ? 'first' : 'last');
  }

  private async selectFile(): Promise<void> {
    const current = this.current;
    if (!current) return;
    const items = current.changeSet.files.map((file, index) => ({
      label: path.basename(file.path),
      description: path.dirname(file.path) === '.' ? '' : path.dirname(file.path),
      detail: file.oldPath ? `${file.status}  ← ${file.oldPath}` : file.status,
      index,
      picked: index === current.index,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `${current.changeSet.title}: ${describeRange(current.changeSet)}`,
      matchOnDescription: true,
      placeHolder: 'Файл набора изменений',
    });
    if (picked) await this.open(current.changeSet, picked.index);
  }

  private async openCurrentFromDiff(): Promise<void> {
    const current = this.current;
    if (!current) return;
    const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;
    await this.openCurrent(current.changeSet, current.index, line);
  }

  private isShowingCurrent(): boolean {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return (
      !!this.current &&
      input instanceof vscode.TabInputTextDiff &&
      input.original.toString() === this.current.left.toString() &&
      input.modified.toString() === this.current.right.toString()
    );
  }

  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, this.isShowingCurrent());
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function hunkLine(hunk: Hunk, side: 'left' | 'right'): number {
  const start = side === 'left' ? hunk.oldStart : hunk.newStart;
  const count = side === 'left' ? hunk.oldLines : hunk.newLines;
  // A zero-length side points at the line after which the change happened.
  return count > 0 ? start - 1 : start;
}

function clampLine(line: number, document: vscode.TextDocument): number {
  return Math.max(0, Math.min(line, document.lineCount - 1));
}
