import type { CommitFile, CommitHostMessage, HunkView } from '../../shared/commitProtocol';
import type { Stash } from '../../shared/model';
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
  noRepository = $state(false);
  busy = $state(false);
  loaded = $state(false);
  checked = $state.raw<ReadonlySet<string>>(new Set());
  selected = $state.raw<ReadonlySet<string>>(new Set());
  recent = $state.raw<string[] | undefined>(undefined);
  /** Hunks of files opened to choose parts of them. */
  hunks = $state.raw<ReadonlyMap<string, HunkView[]>>(new Map());
  /** Hunks left out of the commit, by file; a checked file without any is committed whole. */
  excluded = $state.raw<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  expanded = $state.raw<ReadonlySet<string>>(new Set());

  message = $state('');
  amend = $state(false);
  flat = $state(false);
  messageHeight = $state(130);

  /** Paths seen before, so that new files get default checkboxes and earlier choices are kept. */
  private known = new Set<string>();
  private messageBeforeAmend = '';

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
        this.stashes = message.stashes;
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
        break;
      }
      case 'committed':
        this.message = '';
        this.amend = false;
        this.excluded = new Map();
        this.persist();
        break;
    }
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

  setChecked(paths: string[], value: boolean): void {
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
    if (!this.checked.has(path)) return 'none';
    return this.excluded.get(path)?.size ? 'some' : 'all';
  }

  hunkChecked(path: string, key: string): boolean {
    return this.checked.has(path) && !this.excluded.get(path)?.has(key);
  }

  /** Checking a hunk of an unchecked file takes only that hunk; leaving out every hunk unchecks the file. */
  setHunk(path: string, key: string, value: boolean): void {
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

  commit(push: boolean): void {
    if (this.busy) return;
    const partial = this.checkedFiles.filter((f) => this.excluded.get(f.path)?.size);
    postCommit({
      type: 'commit',
      message: this.message,
      paths: this.checkedFiles.filter((f) => !partial.includes(f)).map((f) => f.path),
      hunks: Object.fromEntries(
        partial.map((f) => [
          f.path,
          (this.hunks.get(f.path) ?? []).map((h) => h.key).filter((k) => !this.excluded.get(f.path)?.has(k)),
        ]),
      ),
      amend: this.amend,
      push,
    });
  }

  private applyFiles(files: CommitFile[]): void {
    const present = new Set(files.map((f) => f.path));
    const checked = new Set([...this.checked].filter((p) => present.has(p)));
    for (const file of files) {
      // As in Rider: changes of versioned files are included by default, unversioned files are not.
      if (!this.known.has(file.path) && file.kind !== 'untracked') checked.add(file.path);
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
  }
}
