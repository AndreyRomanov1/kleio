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

export interface RepositorySnapshot {
  root: string;
  head: Head;
  commits: Commit[];
  refs: Ref[];
  worktrees: Worktree[];
  stashes: Stash[];
}
