import type { CommitFile, CommitHostMessage } from '../../shared/commitProtocol';
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
      case 'committed':
        this.message = '';
        this.amend = false;
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
    }
    this.checked = next;
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
    postCommit({
      type: 'commit',
      message: this.message,
      paths: this.checkedFiles.map((f) => f.path),
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
  }
}
