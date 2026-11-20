import type * as vscode from 'vscode';
import type { ChangeSet } from './changeSet';

const STATE_KEY = 'kleio.navigator.deferred';
/** Change sets whose deferred files are kept; the ones touched longest ago are forgotten. */
const LIMIT = 50;

/**
 * Files of a change set put off to look at later. They are kept by path for {@link ChangeSet.reviewKey}, so the
 * marks of a merge request outlive its new versions, or else for the two revisions of the set.
 */
export class DeferredFiles {
  private all: Record<string, string[]>;

  constructor(private readonly state?: vscode.Memento) {
    this.all = state?.get<Record<string, string[]>>(STATE_KEY, {}) ?? {};
  }

  paths(set: ChangeSet): ReadonlySet<string> {
    return new Set(this.all[keyOf(set)]);
  }

  /** Indexes of the deferred files in the set, in its order. */
  indexes(set: ChangeSet): number[] {
    const paths = this.paths(set);
    return set.files.flatMap((file, index) => (paths.has(file.path) ? [index] : []));
  }

  /** Defers the file or brings it back; returns whether it is deferred now. */
  async toggle(set: ChangeSet, path: string): Promise<boolean> {
    const key = keyOf(set);
    const paths = new Set(this.all[key]);
    const deferred = !paths.delete(path);
    if (deferred) paths.add(path);
    const entries = Object.entries(this.all).filter(([k]) => k !== key);
    if (paths.size) entries.push([key, [...paths]]);
    this.all = Object.fromEntries(entries.slice(-LIMIT));
    await this.state?.update(STATE_KEY, this.all);
    return deferred;
  }
}

function keyOf(set: ChangeSet): string {
  return set.reviewKey ?? `${set.repository.root}\n${set.left ?? ''}\n${set.right}`;
}
