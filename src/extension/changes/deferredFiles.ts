import type * as vscode from 'vscode';
import type { ChangeSet } from './changeSet';

const DEFERRED_KEY = 'kleio.navigator.deferred';
const VIEWED_KEY = 'kleio.navigator.viewed';
/** Change sets whose marks are kept; the ones touched longest ago are forgotten. */
const LIMIT = 50;

/** Paths of a change set marked one way, kept in the workspace state under the key the set gets. */
class MarkedFiles {
  private all: Record<string, string[]>;

  constructor(
    private readonly state: vscode.Memento | undefined,
    private readonly stateKey: string,
    private readonly keyOf: (set: ChangeSet) => string,
  ) {
    this.all = state?.get<Record<string, string[]>>(stateKey, {}) ?? {};
  }

  paths(set: ChangeSet): ReadonlySet<string> {
    return new Set(this.all[this.keyOf(set)]);
  }

  /** Indexes of the marked files in the set, in its order. */
  indexes(set: ChangeSet): number[] {
    const paths = this.paths(set);
    return set.files.flatMap((file, index) => (paths.has(file.path) ? [index] : []));
  }

  protected async set(set: ChangeSet, path: string, marked: boolean): Promise<void> {
    const key = this.keyOf(set);
    const paths = new Set(this.all[key]);
    if (paths.has(path) === marked) return;
    if (marked) paths.add(path);
    else paths.delete(path);
    const entries = Object.entries(this.all).filter(([k]) => k !== key);
    if (paths.size) entries.push([key, [...paths]]);
    this.all = Object.fromEntries(entries.slice(-LIMIT));
    await this.state?.update(this.stateKey, this.all);
  }
}

/**
 * Files of a change set put off to look at later. They are kept by path for {@link ChangeSet.reviewKey}, so the
 * marks of a merge request outlive its new versions, or else for the two revisions of the set.
 */
export class DeferredFiles extends MarkedFiles {
  constructor(state?: vscode.Memento) {
    super(state, DEFERRED_KEY, (set) => set.reviewKey ?? revisionsOf(set));
  }

  /** Defers the file or brings it back; returns whether it is deferred now. */
  async toggle(set: ChangeSet, path: string): Promise<boolean> {
    const deferred = !this.paths(set).has(path);
    await this.set(set, path, deferred);
    return deferred;
  }
}

/** Files of a change set opened in the diff. A new version of a merge request is a new set: its files are new. */
export class ViewedFiles extends MarkedFiles {
  constructor(state?: vscode.Memento) {
    super(state, VIEWED_KEY, revisionsOf);
  }

  mark(set: ChangeSet, path: string): Promise<void> {
    return this.set(set, path, true);
  }
}

function revisionsOf(set: ChangeSet): string {
  return `${set.repository.root}\n${set.left ?? ''}\n${set.right}`;
}
