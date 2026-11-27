import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../../shared/model';
import type { Hunk } from '../git/parse';
import { WORKTREE } from '../git/repository';
import { emptyUri, revisionUri, workingFileUri } from '../content/revisionUri';
import type { RepositoryManager } from '../git/repositoryManager';
import { describeRange, shortRevision, type ChangeSet } from './changeSet';
import { DeferredFiles } from './deferredFiles';
import { categoryOrder, guideOrder, ReviewGuides, type FoundGuide, type GuidePlace } from './reviewGuide';
import { t } from '../../shared/l10n';

interface OpenedFile {
  changeSet: ChangeSet;
  index: number;
  left: vscode.Uri;
  right: vscode.Uri;
  hunks: Hunk[];
  guide?: FoundGuide;
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
const DEFERRED_CONTEXT_KEY = 'kleio.fileDeferred';
/** The change set and file shown last, to pick up the diff tab the editor restores after a reload. */
const SHOWN_KEY = 'kleio.navigator.shown';
/** The file list and F7 follow the categories of the review guide. */
const BY_CATEGORY_KEY = 'kleio.navigator.byCategory';

interface SavedChangeSet {
  root: string;
  title: string;
  left?: string;
  right: string;
  files: FileChange[];
  rightUris?: [string, string][];
  reviewKey?: string;
  branch?: string;
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
  private readonly deferred: DeferredFiles;
  /** F7 went on from the end of the set to the deferred files: now it goes through them only. */
  private deferredPass = false;
  private readonly guides = new ReviewGuides();
  /** Categories left out of the file list and F7, by guide file. */
  private readonly hidden = new Map<string, Set<string>>();
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
    this.deferred = new DeferredFiles(state);
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
      vscode.commands.registerCommand('kleio.diff.defer', () => this.toggleDeferred()),
      vscode.commands.registerCommand('kleio.diff.undefer', () => this.toggleDeferred()),
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
    this.deferredPass = false;
    try {
      await this.show(changeSet, index, edge, show);
    } finally {
      this.opening = false;
    }
  }

  /**
   * After a reload the editor brings the diff tab back, but Kleio has forgotten what it belongs to: the saved
   * change set is taken up again when the restored tab is its file, so F7 and the file list work on.
   * `known` are sets their owner knows again, e.g. a review restored with its comments, to take up the same one.
   */
  async restore(repositories: RepositoryManager, known: readonly ChangeSet[] = []): Promise<void> {
    const saved = this.state?.get<SavedChangeSet>(SHOWN_KEY);
    if (!saved || this.current) return;
    const repository = await repositories.get(saved.root);
    if (!repository) return;
    const set: ChangeSet = known.find(
      (s) => s.title === saved.title && s.left === saved.left && s.right === saved.right,
    ) ?? {
      repository,
      title: saved.title,
      left: saved.left,
      right: saved.right,
      files: saved.files,
      reviewKey: saved.reviewKey,
      branch: saved.branch,
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
          void this.restore(repositories, known);
        });
        setTimeout(() => listener.dispose(), 30_000);
      }
      return;
    }
    const hunks = await repository.hunks(set.left, set.right, change).catch(() => []);
    const guide = await this.guides.find(set).catch(() => undefined);
    this.current = { changeSet: set, index: saved.index, left, right, hunks, guide };
    this.markRename();
    this.updateContext();
  }

  /** The change set of the diff shown last. */
  get shown(): ChangeSet | undefined {
    return this.current?.changeSet;
  }

  /** The file of a change set shown last. */
  get shownFile(): ChangeSetFile | undefined {
    return this.current && { changeSet: this.current.changeSet, index: this.current.index };
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
    const [hunks, guide] = await Promise.all([
      repository.hunks(left, right, change).catch(() => []),
      this.guides.find(changeSet).catch(() => undefined),
    ]);

    const previous = this.replaceable(this.current, leftUri, rightUri);
    this.current = { changeSet, index, left: leftUri, right: rightUri, hunks, guide };
    this.clearEdgeHint();
    const target = edge === 'first' ? hunks[0] : hunks[hunks.length - 1];
    const line = show.line ?? (target ? hunkLine(target, 'right') : 0);
    const moved = change.oldPath && change.oldPath !== change.path ? t(' — moved') : '';
    const title = `${path.basename(change.path)}${moved} (${changeSet.caption ?? describeRange(changeSet)}) — ${index + 1}/${changeSet.files.length}${categoryLabel(guide, index)}`;
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
      reviewKey: changeSet.reviewKey,
      branch: changeSet.branch,
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
    this.showEdgeHint(editor, direction, current.index, this.edgeText(direction));
  }

  /**
   * The file F7 goes on to, in the order of the file list. Past the end of the set it goes to the deferred files,
   * and then only through them; on the way through the set deferred files are not skipped, as they are deferred
   * while being looked at.
   */
  private neighbour(direction: 1 | -1): { index: number; deferred: boolean } | undefined {
    const current = this.current;
    if (!current) return undefined;
    const { changeSet, index } = current;
    const deferred = this.deferred.indexes(changeSet);
    if (this.deferredPass) {
      const next =
        direction === 1 ? deferred.find((i) => i > index) : [...deferred].reverse().find((i) => i < index);
      return next === undefined ? undefined : { index: next, deferred: true };
    }
    const order = this.order(current);
    const at = order.indexOf(index);
    const next = at === -1 ? (direction === 1 ? order[0] : undefined) : order[at + direction];
    if (next !== undefined) return { index: next, deferred: false };
    const first = direction === 1 ? deferred.find((i) => i !== index) : undefined;
    return first === undefined ? undefined : { index: first, deferred: true };
  }

  private edgeText(direction: 1 | -1): string {
    const current = this.current!;
    const neighbour = this.neighbour(direction);
    if (!neighbour) {
      if (this.deferredPass)
        return direction === 1 ? t('The last deferred file') : t('The first deferred file');
      return direction === 1 ? t('The last change of the set') : t('The first change of the set');
    }
    const name = path.basename(current.changeSet.files[neighbour.index].path);
    if (!neighbour.deferred)
      return direction === 1
        ? t('Once more for the next file: {0}', name)
        : t('Once more for the previous file: {0}', name);
    if (!this.deferredPass) {
      const count = this.deferred.indexes(current.changeSet).filter((i) => i !== current.index).length;
      return t('The last change of the set. Once more for the deferred files ({0}): {1}', count, name);
    }
    return direction === 1
      ? t('Once more for the next deferred file: {0}', name)
      : t('Once more for the previous deferred file: {0}', name);
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
    const neighbour = this.neighbour(direction);
    if (!neighbour) {
      vscode.window.setStatusBarMessage(
        this.deferredPass
          ? direction === 1
            ? t('Kleio: this is the last deferred file')
            : t('Kleio: this is the first deferred file')
          : direction === 1
            ? t('Kleio: this is the last change of the set')
            : t('Kleio: this is the first change of the set'),
        3000,
      );
      return;
    }
    await this.open(current.changeSet, neighbour.index, direction === 1 ? 'first' : 'last');
    this.deferredPass = neighbour.deferred;
  }

  private async toggleDeferred(): Promise<void> {
    const current = this.current;
    if (!current || !this.isShowingCurrent()) return;
    const file = current.changeSet.files[current.index];
    const deferred = await this.deferred.toggle(current.changeSet, file.path);
    this.updateContext();
    const name = path.basename(file.path);
    const count = this.deferred.indexes(current.changeSet).length;
    vscode.window.setStatusBarMessage(
      deferred
        ? t('Kleio: {0} is deferred, {1} in the set; F7 comes to them after the last change', name, count)
        : t('Kleio: {0} is no longer deferred', name),
      4000,
    );
  }

  /** The files numbered as in the title of the diff, opened at the current one; by category when there is a guide. */
  private async selectFile(): Promise<void> {
    const current = this.current;
    if (!current) return;
    const { changeSet, guide } = current;
    const places = guide && 'places' in guide ? guide.places : undefined;
    const deferred = this.deferred.indexes(changeSet);
    type Item = vscode.QuickPickItem & { index?: number };
    const itemOf = (index: number, byCategory: boolean): Item => {
      const file = changeSet.files[index];
      const dir = path.dirname(file.path) === '.' ? '' : path.dirname(file.path);
      const place = byCategory ? places?.[index] : undefined;
      return {
        label: `${deferred.includes(index) ? '$(flag) ' : ''}${index + 1}. ${path.basename(file.path)}`,
        description: [
          place?.importance ? `[${place.importance}]` : '',
          file.status,
          file.oldPath ? `${dir}  ← ${file.oldPath}` : dir,
        ]
          .filter(Boolean)
          .join('  '),
        detail: place?.note,
        index,
      };
    };
    const separator = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const toggle: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('list-tree'),
      tooltip: t('Group by the categories of the review guide'),
    };
    const plain: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('list-flat'),
      tooltip: t('Plain list'),
    };
    const filter: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('filter'),
      tooltip: t('Categories to show…'),
    };

    const pick = vscode.window.createQuickPick<Item>();
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    const fill = (): void => {
      const byCategory = !!places && this.byCategory;
      const hidden = guide ? this.hiddenOf(guide.file) : new Set<string>();
      const items: Item[] = deferred.length
        ? [separator(t('Deferred')), ...deferred.map((index) => itemOf(index, byCategory))]
        : [];
      if (byCategory) {
        const order = guideOrder(places, hidden);
        for (const category of categoryOrder(places).filter((c) => !hidden.has(c.id))) {
          const count = order.filter((i) => places[i].category.id === category.id).length;
          items.push(
            separator(
              `${category.title}${category.importance ? ` · ${category.importance}` : ''} (${count})`,
            ),
            ...order.filter((i) => places[i].category.id === category.id).map((i) => itemOf(i, true)),
          );
        }
      } else {
        if (deferred.length) items.push(separator(t('All files')));
        items.push(...changeSet.files.map((_, index) => itemOf(index, false)));
      }
      pick.items = items;
      pick.activeItems = [[...items].reverse().find((i) => i.index === current.index) ?? items[0]];
      pick.buttons = places ? (byCategory ? [filter, plain] : [toggle]) : [];
      pick.title = [
        `${changeSet.title}: ${describeRange(changeSet)} — ${current.index + 1}/${changeSet.files.length}`,
        deferred.length ? t('deferred: {0}', deferred.length) : '',
        byCategory && hidden.size ? t('categories hidden: {0}', hidden.size) : '',
        guideState(guide),
      ]
        .filter(Boolean)
        .join(', ');
      pick.placeholder =
        (byCategory && guide && 'guide' in guide && guide.guide.summary) ||
        t('File of the change set: name, folder or number');
    };
    fill();
    const picked = await new Promise<Item | undefined>((resolve) => {
      pick.onDidTriggerButton(async (button) => {
        if (button === filter && places && guide) {
          pick.hide();
          await this.chooseCategories(guide.file, places);
          resolve(undefined);
          void this.selectFile();
          return;
        }
        await this.state?.update(BY_CATEGORY_KEY, button === toggle);
        fill();
      });
      pick.onDidAccept(() => resolve(pick.selectedItems[0]));
      pick.onDidHide(() => resolve(undefined));
      pick.show();
    });
    pick.dispose();
    if (picked?.index !== undefined) await this.open(changeSet, picked.index);
  }

  private async chooseCategories(file: string, places: readonly GuidePlace[]): Promise<void> {
    const hidden = this.hiddenOf(file);
    const items = categoryOrder(places).map((category) => ({
      label: category.title,
      description: [
        category.importance ? `[${category.importance}]` : '',
        t('files: {0}', places.filter((p) => p.category.id === category.id).length),
      ]
        .filter(Boolean)
        .join('  '),
      detail: category.description,
      picked: !hidden.has(category.id),
      id: category.id,
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: t('Categories to show in the file list and to go through with F7'),
      matchOnDetail: true,
    });
    if (!chosen) return;
    const shown = new Set(chosen.map((c) => c.id));
    this.hidden.set(file, new Set(items.filter((c) => !shown.has(c.id)).map((c) => c.id)));
  }

  private get byCategory(): boolean {
    return this.state?.get<boolean>(BY_CATEGORY_KEY, true) ?? true;
  }

  private hiddenOf(file: string): Set<string> {
    return this.hidden.get(file) ?? new Set();
  }

  /** The files of the set in the order F7 goes through them. */
  private order(file: OpenedFile): number[] {
    const { guide } = file;
    if (!this.byCategory || !guide || !('places' in guide)) return file.changeSet.files.map((_, i) => i);
    return guideOrder(guide.places, this.hiddenOf(guide.file));
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
    const showing = this.isShowingCurrent();
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, showing);
    const current = this.current;
    const deferred =
      showing &&
      !!current &&
      this.deferred.paths(current.changeSet).has(current.changeSet.files[current.index].path);
    void vscode.commands.executeCommand('setContext', DEFERRED_CONTEXT_KEY, deferred);
  }

  dispose(): void {
    clearTimeout(this.hintTimer);
    for (const d of this.disposables) d.dispose();
  }
}

/** The category of the file for the title of the diff. */
function categoryLabel(guide: FoundGuide | undefined, index: number): string {
  if (!guide || !('places' in guide)) return '';
  const place = guide.places[index];
  return place.category.importance ? ` · ${place.category.title}` : '';
}

function guideState(guide: FoundGuide | undefined): string {
  if (!guide) return '';
  if ('error' in guide) return t('the review guide cannot be read: {0}', guide.error);
  return guide.stale ? t('the review guide is made for {0}', shortRevision(guide.guide.head)) : '';
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
