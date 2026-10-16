import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../../shared/model';
import type { Hunk } from '../git/parse';
import { WORKTREE } from '../git/repository';
import { emptyUri, revisionUri, workingFileUri } from '../content/revisionUri';
import type { RepositoryManager } from '../git/repositoryManager';
import { describeRange, shortRevision, type ChangeSet } from './changeSet';
import { t } from '../../shared/l10n';

interface OpenedFile {
  changeSet: ChangeSet;
  index: number;
  left: vscode.Uri;
  right: vscode.Uri;
  hunks: Hunk[];
}

type Edge = 'first' | 'last';

export interface ShowOptions {
  /** Group for the first diff; later files of the set replace it in place. */
  viewColumn?: vscode.ViewColumn;
  /** Keep focus where it is, e.g. in a history list browsed with arrow keys. */
  preserveFocus?: boolean;
  /** 0-based line of the new side to reveal instead of the first change. */
  line?: number;
}

interface EdgeHint {
  direction: 1 | -1;
  index: number;
  at: number;
  document: vscode.Uri;
  line: number;
}

const CONTEXT_KEY = 'kleio.inChangeSet';
/** The change set and file shown last, to pick up the diff tab the editor restores after a reload. */
const SHOWN_KEY = 'kleio.navigator.shown';

interface SavedChangeSet {
  root: string;
  title: string;
  left?: string;
  right: string;
  files: FileChange[];
  rightUris?: [string, string][];
  index: number;
}

/** A file of a change set, as the navigation history keeps it. */
export interface ChangeSetFile {
  changeSet: ChangeSet;
  index: number;
}
const EDGE_HINT_MS = 4000;

/**
 * Rider-style diff viewer on top of the built-in diff editor: one file of a change set at a time,
 * "next difference" continues into the next file when the current one has no more changes.
 */
export class ChangeSetNavigator implements vscode.Disposable {
  private current?: OpenedFile;
  private edgeHint?: EdgeHint;
  private readonly opened = new vscode.EventEmitter<ChangeSetFile & { line: number }>();
  private waitingForTabs = false;
  /** True while a file is being opened: tabs come and go for a moment then. */
  opening = false;

  /** Fires once a file of a change set is shown, with the line revealed. */
  readonly onDidOpen = this.opened.event;
  private readonly hintDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorInfo.foreground'),
      fontStyle: 'italic',
      margin: '0 0 0 3em',
    },
  });
  private hintTimer?: NodeJS.Timeout;
  private readonly renameDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('descriptionForeground'),
      fontStyle: 'italic',
      margin: '0 0 0 3em',
    },
  });
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly state?: vscode.Memento) {
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateContext()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelectionChanged(e)),
      this.hintDecoration,
      this.renameDecoration,
      vscode.window.onDidChangeVisibleTextEditors(() => this.markRename()),
      vscode.commands.registerCommand('kleio.diff.nextChange', () => this.moveChange(1)),
      vscode.commands.registerCommand('kleio.diff.previousChange', () => this.moveChange(-1)),
      vscode.commands.registerCommand('kleio.diff.nextFile', () => this.moveFile(1)),
      vscode.commands.registerCommand('kleio.diff.previousFile', () => this.moveFile(-1)),
      vscode.commands.registerCommand('kleio.diff.selectFile', () => this.selectFile()),
      this.opened,
      vscode.commands.registerCommand('kleio.diff.openCurrent', () => this.openCurrentFromDiff()),
    );
  }

  async open(
    changeSet: ChangeSet,
    index: number,
    edge: Edge = 'first',
    show: ShowOptions = {},
  ): Promise<void> {
    this.opening = true;
    try {
      await this.show(changeSet, index, edge, show);
    } finally {
      this.opening = false;
    }
  }

  /**
   * After a reload the editor brings the diff tab back, but Kleio has forgotten what it belongs to: the saved
   * change set is taken up again when the restored tab is its file, so F7 and the file list work on.
   * `changeSet` is the same set known again by its owner, e.g. a review restored with its comments.
   */
  async restore(repositories: RepositoryManager, changeSet?: ChangeSet): Promise<void> {
    const saved = this.state?.get<SavedChangeSet>(SHOWN_KEY);
    if (!saved || this.current) return;
    const repository = await repositories.get(saved.root);
    if (!repository) return;
    const set: ChangeSet = changeSet ?? {
      repository,
      title: saved.title,
      left: saved.left,
      right: saved.right,
      files: saved.files,
      rightUris: saved.rightUris && new Map(saved.rightUris.map(([p, u]) => [p, vscode.Uri.parse(u)])),
    };
    const change = set.files[saved.index];
    if (!change) return;
    const left =
      change.status === 'A' || set.left === undefined
        ? emptyUri(repository.root, change.path)
        : revisionUri(repository.root, set.left, change.oldPath ?? change.path);
    const right =
      change.status === 'D' ? emptyUri(repository.root, change.path) : await this.rightSideUri(set, change);
    const restored = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .some(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.original.toString() === left.toString() &&
          tab.input.modified.toString() === right.toString(),
      );
    if (!restored) {
      // The editor may bring its tabs back after Kleio has started: one more look when they come.
      if (!this.waitingForTabs) {
        this.waitingForTabs = true;
        const listener = vscode.window.tabGroups.onDidChangeTabs(() => {
          listener.dispose();
          void this.restore(repositories, changeSet);
        });
        setTimeout(() => listener.dispose(), 30_000);
      }
      return;
    }
    const hunks = await repository.hunks(set.left, set.right, change).catch(() => []);
    this.current = { changeSet: set, index: saved.index, left, right, hunks };
    this.markRename();
    this.updateContext();
  }

  /** The change set of the diff shown last. */
  get shown(): ChangeSet | undefined {
    return this.current?.changeSet;
  }

  /** The file of a change set an editor shows, on either side of the diff. */
  fileOf(uri: vscode.Uri): ChangeSetFile | undefined {
    const current = this.current;
    const key = uri.toString();
    if (!current || (key !== current.right.toString() && key !== current.left.toString())) return undefined;
    return { changeSet: current.changeSet, index: current.index };
  }

  private async show(changeSet: ChangeSet, index: number, edge: Edge, show: ShowOptions): Promise<void> {
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

    const previous = this.replaceable(this.current, leftUri, rightUri);
    this.current = { changeSet, index, left: leftUri, right: rightUri, hunks };
    this.clearEdgeHint();
    const target = edge === 'first' ? hunks[0] : hunks[hunks.length - 1];
    const line = show.line ?? (target ? hunkLine(target, 'right') : 0);
    const moved = change.oldPath && change.oldPath !== change.path ? t(' — moved') : '';
    const title = `${path.basename(change.path)}${moved} (${describeRange(changeSet)}) — ${index + 1}/${changeSet.files.length}`;
    const options: vscode.TextDocumentShowOptions = {
      preview: true,
      preserveFocus: show.preserveFocus,
      selection: new vscode.Range(line, 0, line, 0),
    };

    // Kleio keeps one diff tab, as Rider's diff window, even with editor previews turned off. The old tab is
    // closed first and the new one takes its place, so the tab bar does not grow and shift for a moment.
    // A tab that is alone in its group is closed afterwards instead: closing it first would close the group.
    if (previous && previous.group.tabs.length > 1) {
      await vscode.window.tabGroups.close(previous.tab, true);
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
        ...options,
        viewColumn: previous.group.viewColumn,
      });
      if (!show.preserveFocus) await this.moveActiveTabTo(previous.index);
    } else {
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
        ...options,
        viewColumn: previous?.group.viewColumn ?? show.viewColumn,
      });
      // With editor previews on, the new diff may have taken the preview tab of the old one already.
      if (previous) await vscode.window.tabGroups.close(previous.tab, true).then(undefined, () => undefined);
    }
    this.markRename();
    this.updateContext();
    this.opened.fire({ changeSet, index, line });
    void this.state?.update(SHOWN_KEY, {
      root,
      title: changeSet.title,
      left,
      right,
      files: changeSet.files,
      rightUris: changeSet.rightUris && [...changeSet.rightUris].map(([p, u]) => [p, u.toString()]),
      index,
    } satisfies SavedChangeSet);
  }

  /** A moved file looks unchanged inside the diff, so its old and new paths are shown on the first line. */
  private markRename(): void {
    const current = this.current;
    const change = current?.changeSet.files[current.index];
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      const isLeft = uri === current?.left.toString();
      const isRight = uri === current?.right.toString();
      if (
        !change?.oldPath ||
        change.oldPath === change.path ||
        (!isLeft && !isRight) ||
        editor.document.lineCount === 0
      ) {
        editor.setDecorations(this.renameDecoration, []);
        continue;
      }
      const unchanged = current!.hunks.length === 0 ? t(', contents unchanged') : '';
      const text = isRight
        ? t('⟵ moved from {0}', change.oldPath ?? '') + unchanged
        : t('⟶ moved to {0}', change.path) + unchanged;
      const end = editor.document.lineAt(0).range.end;
      editor.setDecorations(this.renameDecoration, [
        { range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } },
      ]);
    }
  }

  /** The tab of the previously shown file, if it can be replaced: not the same file, not edited, not pinned. */
  private replaceable(
    file: OpenedFile | undefined,
    left: vscode.Uri,
    right: vscode.Uri,
  ): { tab: vscode.Tab; group: vscode.TabGroup; index: number } | undefined {
    if (!file) return undefined;
    if (file.left.toString() === left.toString() && file.right.toString() === right.toString())
      return undefined;
    const tab = this.findTab(file);
    if (!tab || tab.isDirty || tab.isPinned) return undefined;
    return { tab, group: tab.group, index: tab.group.tabs.indexOf(tab) };
  }

  private async moveActiveTabTo(index: number): Promise<void> {
    const group = vscode.window.tabGroups.activeTabGroup;
    if (index < 0) return;
    const current = group.tabs.findIndex((t) => t.isActive);
    if (current === index || current < 0) return;
    await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: index + 1 });
  }

  private findTab(file: OpenedFile | undefined): vscode.Tab | undefined {
    if (!file) return undefined;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputTextDiff &&
          input.original.toString() === file.left.toString() &&
          input.modified.toString() === file.right.toString()
        ) {
          return tab;
        }
      }
    }
    return undefined;
  }

  async openCurrent(changeSet: ChangeSet, index: number, line = 0): Promise<void> {
    const change = changeSet.files[index];
    if (!change) return;
    const uri = workingFileUri(changeSet.repository.root, change.path);
    if (!fs.existsSync(uri.fsPath)) {
      void vscode.window.showWarningMessage(t('File {0} is not in the working tree.', change.path));
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
    const title = `${path.basename(change.path)} (${t('{0} ↔ working tree', shortRevision(changeSet.right))})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  /**
   * A revision identical to the file on disk is shown as the real file: it stays editable and language
   * servers work in it, as in Rider.
   */
  private async rightSideUri(changeSet: ChangeSet, change: FileChange): Promise<vscode.Uri> {
    const known = changeSet.rightUris?.get(change.path);
    if (known) return known;
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

    // As in Rider: at the last change the first press only warns, the second one opens the next file.
    const hint = this.edgeHint;
    const confirmed =
      hint?.direction === direction && hint.index === current.index && Date.now() - hint.at < EDGE_HINT_MS;
    if (confirmed || lines.length === 0) {
      this.clearEdgeHint();
      await this.moveFile(direction);
      return;
    }
    const target = current.changeSet.files[current.index + direction];
    if (!target) {
      this.showEdgeHint(
        editor,
        direction,
        current.index,
        direction === 1 ? t('The last change of the set') : t('The first change of the set'),
      );
      return;
    }
    this.showEdgeHint(
      editor,
      direction,
      current.index,
      direction === 1
        ? t('Once more for the next file: {0}', path.basename(target.path))
        : t('Once more for the previous file: {0}', path.basename(target.path)),
    );
  }

  private showEdgeHint(editor: vscode.TextEditor, direction: 1 | -1, index: number, text: string): void {
    this.clearEdgeHint();
    const line = editor.selection.active.line;
    const end = editor.document.lineAt(line).range.end;
    editor.setDecorations(this.hintDecoration, [
      { range: new vscode.Range(end, end), renderOptions: { after: { contentText: `⟶ ${text}` } } },
    ]);
    this.edgeHint = { direction, index, at: Date.now(), document: editor.document.uri, line };
    this.hintTimer = setTimeout(() => this.clearEdgeHint(), EDGE_HINT_MS);
  }

  /** Selection events arrive late, so only a real move of the cursor away from the hint cancels it. */
  private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    const hint = this.edgeHint;
    if (!hint || event.textEditor.document.uri.toString() !== hint.document.toString()) return;
    if (event.selections[0]?.active.line !== hint.line) this.clearEdgeHint();
  }

  private clearEdgeHint(): void {
    clearTimeout(this.hintTimer);
    this.hintTimer = undefined;
    if (!this.edgeHint) return;
    this.edgeHint = undefined;
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.hintDecoration, []);
  }

  private async moveFile(direction: 1 | -1): Promise<void> {
    const current = this.current;
    if (!current) return;
    const index = current.index + direction;
    if (index < 0 || index >= current.changeSet.files.length) {
      vscode.window.setStatusBarMessage(
        direction === 1
          ? t('Kleio: this is the last change of the set')
          : t('Kleio: this is the first change of the set'),
        3000,
      );
      return;
    }
    await this.open(current.changeSet, index, direction === 1 ? 'first' : 'last');
  }

  /** The files numbered as in the title of the diff, opened at the current one. */
  private async selectFile(): Promise<void> {
    const current = this.current;
    if (!current) return;
    const items = current.changeSet.files.map((file, index) => {
      const dir = path.dirname(file.path) === '.' ? '' : path.dirname(file.path);
      return {
        label: `${index + 1}. ${path.basename(file.path)}`,
        description: [file.status, file.oldPath ? `${dir}  ← ${file.oldPath}` : dir]
          .filter(Boolean)
          .join('  '),
        index,
      };
    });
    const pick = vscode.window.createQuickPick<(typeof items)[number]>();
    pick.title = `${current.changeSet.title}: ${describeRange(current.changeSet)} — ${current.index + 1}/${items.length}`;
    pick.placeholder = t('File of the change set: name, folder or number');
    pick.matchOnDescription = true;
    pick.items = items;
    pick.activeItems = [items[current.index]];
    const picked = await new Promise<(typeof items)[number] | undefined>((resolve) => {
      pick.onDidAccept(() => resolve(pick.selectedItems[0]));
      pick.onDidHide(() => resolve(undefined));
      pick.show();
    });
    pick.dispose();
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
    clearTimeout(this.hintTimer);
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
