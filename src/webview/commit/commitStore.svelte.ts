import {
  hunkSelection,
  type CommitFile,
  type CommitHostMessage,
  type HunkView,
} from '../../shared/commitProtocol';
import type { OperationState, Stash } from '../../shared/model';
import { loadState, postCommit, saveState } from '../vscode';

interface Saved {
  message: string;
  amend: boolean;
  flat: boolean;
  messageHeight: number;
}

/** State of the commit view: the working copy from the host, checkboxes, selection and the message draft. */
export class CommitStore {
  files = $state.raw<CommitFile[]>([]);
  stashes = $state.raw<Stash[]>([]);
  branch = $state<string | undefined>(undefined);
  root = $state('');
  repositories = $state.raw<{ root: string; name: string }[]>([]);
  noRepository = $state(false);
  busy = $state(false);
  loaded = $state(false);
  operation = $state.raw<OperationState | undefined>(undefined);
  /** Checkboxes show the staging area; set by the host from the settings. */
  staging = $state(false);
  checked = $state.raw<ReadonlySet<string>>(new Set());
  selected = $state.raw<ReadonlySet<string>>(new Set());
  recent = $state.raw<string[] | undefined>(undefined);
  /** Hunks of files opened to choose parts of them. */
  hunks = $state.raw<ReadonlyMap<string, HunkView[]>>(new Map());
  /** Hunks left out of the commit, by file; a checked file without any is committed whole. */
  excluded = $state.raw<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  /** Lines left out of hunks that are otherwise committed: file → hunk → indexes of the lines. */
  excludedLines = $state.raw<ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>>(new Map());
  /** Hunks opened to choose single lines: `path\0key`. */
  openHunks = $state.raw<ReadonlySet<string>>(new Set());
  expanded = $state.raw<ReadonlySet<string>>(new Set());

  message = $state('');
  amend = $state(false);
  flat = $state(false);
  messageHeight = $state(130);

  /** Paths seen before, so that new files get default checkboxes and earlier choices are kept. */
  private known = new Set<string>();
  private messageBeforeAmend = '';
  /** The message git prepared, last seen: it fills an empty message box and leaves with the operation. */
  private prepared?: string;

  constructor() {
    const saved = loadState<Saved>({ message: '', amend: false, flat: false, messageHeight: 130 });
    this.message = saved.message;
    this.amend = saved.amend;
    this.flat = saved.flat;
    this.messageHeight = saved.messageHeight;
  }

  persist(): void {
    saveState({
      message: this.message,
      amend: this.amend,
      flat: this.flat,
      messageHeight: this.messageHeight,
    });
  }

  handle(message: CommitHostMessage): void {
    switch (message.type) {
      case 'state':
        this.noRepository = false;
        this.loaded = true;
        this.branch = message.branch;
        this.repositories = message.repositories;
        // Checkboxes and hunks belong to the files of one repository.
        if (message.root !== this.root) this.forget();
        this.root = message.root;
        this.stashes = message.stashes;
        this.staging = message.staging;
        this.operation = message.operation;
        this.applyPrepared(message.preparedMessage);
        this.applyFiles(message.files);
        break;
      case 'noRepository':
        this.noRepository = true;
        break;
      case 'busy':
        this.busy = message.value;
        break;
      case 'amendMessage':
        if (this.amend && (!this.message.trim() || this.message === this.messageBeforeAmend))
          this.message = message.message;
        break;
      case 'recentMessages':
        this.recent = message.messages;
        break;
      case 'hunks': {
        const hunks = new Map(this.hunks);
        hunks.set(message.path, message.hunks);
        this.hunks = hunks;
        // Hunks that are gone (committed, reverted, edited) are no longer left out.
        const left = this.excluded.get(message.path);
        if (left) {
          const keys = new Set(message.hunks.map((h) => h.key));
          this.setExcluded(message.path, new Set([...left].filter((k) => keys.has(k))));
        }
        const lines = this.excludedLines.get(message.path);
        if (lines) {
          const kept = new Map(
            message.hunks.flatMap((h) => {
              const left = lines.get(h.key);
              return left && h.lines ? [[h.key, left] as const] : [];
            }),
          );
          this.setExcludedLines(message.path, kept);
        }
        break;
      }
      case 'committed':
        this.prepared = undefined;
        this.message = '';
        this.amend = false;
        this.excluded = new Map();
        this.excludedLines = new Map();
        this.persist();
        break;
    }
  }

  private applyPrepared(prepared: string | undefined): void {
    if (prepared === this.prepared) return;
    const untouched = !this.message.trim() || this.message === this.prepared;
    if (untouched) {
      this.message = prepared ?? '';
      this.persist();
    }
    this.prepared = prepared;
  }

  get checkedFiles(): CommitFile[] {
    return this.files.filter((f) => this.checked.has(f.path));
  }

  setAmend(value: boolean): void {
    this.amend = value;
    if (value) {
      this.messageBeforeAmend = this.message;
      postCommit({ type: 'requestAmendMessage' });
    } else if (this.messageBeforeAmend !== undefined) {
      this.message = this.messageBeforeAmend;
    }
    this.persist();
  }

  setStaging(value: boolean): void {
    this.staging = value;
    this.hunks = new Map();
    this.excluded = new Map();
    this.excludedLines = new Map();
    postCommit({ type: 'setStaging', value });
  }

  setChecked(paths: string[], value: boolean): void {
    if (this.staging) {
      postCommit({ type: 'stage', paths, value });
      return;
    }
    const next = new Set(this.checked);
    for (const p of paths) {
      if (value) next.add(p);
      else next.delete(p);
      this.setExcluded(p, new Set());
    }
    this.checked = next;
  }

  /** Checkbox state of a file: some when part of its hunks is left out. */
  fileState(path: string): 'all' | 'some' | 'none' {
    if (this.staging) return this.files.find((f) => f.path === path)?.staged ?? 'none';
    if (!this.checked.has(path)) return 'none';
    return this.excluded.get(path)?.size || this.excludedLines.get(path)?.size ? 'some' : 'all';
  }

  hunkChecked(path: string, key: string): boolean {
    if (this.staging) return this.hunks.get(path)?.find((h) => h.key === key)?.staged ?? false;
    return this.checked.has(path) && !this.excluded.get(path)?.has(key);
  }

  hunkState(path: string, key: string): 'all' | 'some' | 'none' {
    if (!this.hunkChecked(path, key)) return 'none';
    return this.excludedLines.get(path)?.get(key)?.size ? 'some' : 'all';
  }

  /** In the staging area a line is staged with its hunk; it moves to the other side when toggled. */
  lineChecked(path: string, key: string, index: number): boolean {
    return this.hunkChecked(path, key) && !this.excludedLines.get(path)?.get(key)?.has(index);
  }

  /** Checking a line of an unchecked hunk takes only that line; leaving out every line unchecks the hunk. */
  setLine(path: string, key: string, index: number, value: boolean): void {
    if (this.staging) {
      postCommit({ type: 'stageHunk', path, key: hunkSelection(key, [index]), value });
      return;
    }
    const lines = (this.hunks.get(path)?.find((h) => h.key === key)?.lines ?? []).map((l) => l.index);
    let left: Set<number>;
    if (!this.hunkChecked(path, key)) {
      if (!value) return;
      this.setHunk(path, key, true);
      left = new Set(lines.filter((i) => i !== index));
    } else {
      left = new Set(this.excludedLines.get(path)?.get(key));
      if (value) left.delete(index);
      else left.add(index);
    }
    if (lines.length && lines.every((i) => left.has(i))) {
      this.setHunk(path, key, false);
      return;
    }
    const next = new Map(this.excludedLines.get(path));
    if (left.size) next.set(key, left);
    else next.delete(key);
    this.setExcludedLines(path, next);
  }

  toggleHunkLines(path: string, key: string): void {
    const id = `${path}\0${key}`;
    const next = new Set(this.openHunks);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.openHunks = next;
  }

  /** The hunks of a file to commit or roll back, with the lines chosen in part. */
  private selections(path: string): string[] {
    const lines = this.excludedLines.get(path);
    return (this.hunks.get(path) ?? [])
      .filter((h) => !this.excluded.get(path)?.has(h.key))
      .map((h) => {
        const left = lines?.get(h.key);
        if (!left?.size || !h.lines) return h.key;
        return hunkSelection(
          h.key,
          h.lines.map((l) => l.index).filter((i) => !left.has(i)),
        );
      });
  }

  private partlyChecked(path: string): boolean {
    return !!(this.excluded.get(path)?.size || this.excludedLines.get(path)?.size);
  }

  private setExcludedLines(path: string, lines: ReadonlyMap<string, ReadonlySet<number>>): void {
    if (!lines.size && !this.excludedLines.has(path)) return;
    const next = new Map(this.excludedLines);
    if (lines.size) next.set(path, lines);
    else next.delete(path);
    this.excludedLines = next;
  }

  /** Checking a hunk of an unchecked file takes only that hunk; leaving out every hunk unchecks the file. */
  setHunk(path: string, key: string, value: boolean): void {
    if (this.staging) {
      postCommit({ type: 'stageHunk', path, key, value });
      return;
    }
    const lines = this.excludedLines.get(path);
    if (lines?.has(key)) {
      const next = new Map(lines);
      next.delete(key);
      this.setExcludedLines(path, next);
    }
    const keys = (this.hunks.get(path) ?? []).map((h) => h.key);
    let left: Set<string>;
    if (!this.checked.has(path)) {
      if (!value) return;
      left = new Set(keys.filter((k) => k !== key));
      const checked = new Set(this.checked);
      checked.add(path);
      this.checked = checked;
    } else {
      left = new Set(this.excluded.get(path));
      if (value) left.delete(key);
      else left.add(key);
    }
    if (keys.length && keys.every((k) => left.has(k))) {
      const checked = new Set(this.checked);
      checked.delete(path);
      this.checked = checked;
      left = new Set();
    }
    this.setExcluded(path, left);
  }

  toggleExpanded(path: string): void {
    const next = new Set(this.expanded);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      postCommit({ type: 'requestHunks', path });
    }
    this.expanded = next;
  }

  private setExcluded(path: string, keys: ReadonlySet<string>): void {
    if (!keys.size && !this.excluded.has(path)) return;
    const next = new Map(this.excluded);
    if (keys.size) next.set(path, keys);
    else next.delete(path);
    this.excluded = next;
  }

  select(path: string, toggle: boolean): void {
    if (toggle) {
      const next = new Set(this.selected);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      this.selected = next;
    } else {
      this.selected = new Set([path]);
    }
  }

  /** Paths the toolbar acts on: the selection, or the checked files when nothing is selected. */
  get targets(): string[] {
    const selected = this.files.filter((f) => this.selected.has(f.path)).map((f) => f.path);
    return selected.length ? selected : this.checkedFiles.map((f) => f.path);
  }

  /**
   * What "rollback" acts on: the selected files, or the checked ones when nothing is selected. A file checked
   * in part loses only its checked hunks, as the checkboxes show.
   */
  rollbackTargets(): { paths: string[]; hunks: Record<string, string[]> } {
    const paths: string[] = [];
    const hunks: Record<string, string[]> = {};
    for (const path of this.targets) {
      if (this.staging) {
        paths.push(path);
        continue;
      }
      if (this.partlyChecked(path) && this.checked.has(path)) {
        hunks[path] = this.selections(path);
      } else {
        paths.push(path);
      }
    }
    return { paths, hunks };
  }

  commit(push: boolean): void {
    if (this.busy) return;
    const partial = this.checkedFiles.filter((f) => this.partlyChecked(f.path));
    postCommit({
      type: 'commit',
      message: this.message,
      paths: this.checkedFiles.filter((f) => !partial.includes(f)).map((f) => f.path),
      hunks: Object.fromEntries(partial.map((f) => [f.path, this.selections(f.path)])),
      amend: this.amend,
      push,
    });
  }

  private forget(): void {
    this.known = new Set();
    this.checked = new Set();
    this.selected = new Set();
    this.hunks = new Map();
    this.excluded = new Map();
    this.excludedLines = new Map();
    this.expanded = new Set();
    this.openHunks = new Set();
  }

  private applyFiles(files: CommitFile[]): void {
    const present = new Set(files.map((f) => f.path));
    const checked = new Set([...this.checked].filter((p) => present.has(p)));
    if (this.staging) {
      checked.clear();
      for (const file of files) if (file.staged && file.staged !== 'none') checked.add(file.path);
    }
    for (const file of files) {
      // As in Rider: changes of versioned files are included by default, unversioned files are not.
      if (!this.staging && !this.known.has(file.path) && file.kind !== 'untracked') checked.add(file.path);
      this.known.add(file.path);
    }
    this.files = files;
    this.checked = checked;
    this.selected = new Set([...this.selected].filter((p) => present.has(p)));
    // Hunks change with the file: those on screen or partly left out are asked again.
    for (const path of new Set([...this.expanded, ...this.excluded.keys()])) {
      if (present.has(path)) postCommit({ type: 'requestHunks', path });
    }
    this.expanded = new Set([...this.expanded].filter((p) => present.has(p)));
    this.excluded = new Map([...this.excluded].filter(([p]) => present.has(p)));
    this.excludedLines = new Map([...this.excludedLines].filter(([p]) => present.has(p)));
  }
}
