export interface Commit {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Unix time, seconds. */
  authorDate: number;
  subject: string;
}

export type RefKind = 'head' | 'remote' | 'tag';

export interface Ref {
  /** Full name, e.g. `refs/heads/main`. */
  fullName: string;
  /** Display name, e.g. `main` or `origin/main`. */
  name: string;
  kind: RefKind;
  /** Commit the ref points to (annotated tags are peeled). */
  hash: string;
  /** Full name of the upstream ref for local branches. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  upstreamGone?: boolean;
}

export interface Head {
  /** Undefined on an empty repository. */
  hash?: string;
  /** Short branch name, undefined when HEAD is detached. */
  branch?: string;
}

export interface Worktree {
  path: string;
  head?: string;
  /** Short branch name, undefined when detached. */
  branch?: string;
  isMain: boolean;
  isCurrent: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface Stash {
  hash: string;
  parents: string[];
  /** `stash@{0}`. */
  selector: string;
  date: number;
  message: string;
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface FileChange {
  status: ChangeStatus;
  /** Path relative to the repository root, in the new revision. */
  path: string;
  /** Path in the old revision for renames and copies. */
  oldPath?: string;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: number;
  committerName: string;
  committerEmail: string;
  commitDate: number;
  message: string;
}

export type OperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** A merge, rebase, cherry-pick or revert stopped half-way, waiting for conflicts or an edit. */
export interface OperationState {
  kind: OperationKind;
  /** Short name of the branch being rebased. */
  branch?: string;
  /** Commit the branch is rebased onto, or the one being merged, picked or reverted. */
  onto?: string;
  /** 1-based step of a rebase and the number of its steps. */
  step?: number;
  total?: number;
  /** Commit the rebase stopped at, e.g. for an edit. */
  stoppedAt?: string;
  conflicted: string[];
}

/** Filters of the log that git applies, as opposed to the text search over the loaded commits. */
export interface LogQuery {
  /** Parts of author names or emails; a commit by any of them passes. */
  authors?: string[];
  /** Dates as git takes them: `2026-01-31`, `2 weeks ago`. */
  since?: string;
  until?: string;
  /** Paths relative to the repository root; commits touching any of them pass. */
  paths?: string[];
  /** Text added or removed by the commit (`git log -S`), or a regular expression of changed lines (`-G`). */
  changes?: string;
  changesRegex?: boolean;
}

/** Whether the query keeps commits whose neighbours are hidden, so that the graph has no lines to draw. */
export function breaksGraph(query: LogQuery): boolean {
  return !!(query.authors?.length || query.since || query.until || query.changes);
}

export function isEmptyQuery(query: LogQuery): boolean {
  return !breaksGraph(query) && !query.paths?.length;
}

export interface RepositorySnapshot {
  root: string;
  head: Head;
  commits: Commit[];
  refs: Ref[];
  worktrees: Worktree[];
  stashes: Stash[];
  operation?: OperationState;
  /** The log was cut at a limit; older commits are loaded on request. */
  truncated?: boolean;
}
