import type { CommitDetails, FileChange, RepositorySnapshot } from './model';

export interface RepositoryInfo {
  root: string;
  name: string;
}

export interface ChangeSetView {
  id: number;
  title: string;
  /** Short description of the compared revisions, e.g. `a1b2c3d^ ↔ a1b2c3d`. */
  range: string;
  files: FileChange[];
}

export type CommitAction =
  'checkout' | 'newBranch' | 'newTag' | 'revert' | 'copyHash' | 'copySubject' | 'compareWithWorktree';

export type RefAction =
  | 'checkout'
  | 'newBranch'
  | 'deleteBranch'
  | 'deleteRemoteBranch'
  | 'fetchBranch'
  | 'showDiffWithCurrent'
  | 'copyName';

export type FileAction = 'openDiff' | 'openCurrent' | 'openRevision' | 'compareWithWorktree' | 'copyPath';

export type HostMessage =
  | {
      type: 'snapshot';
      repositories: RepositoryInfo[];
      snapshot: RepositorySnapshot;
      focus: string[];
      favorites: string[];
    }
  | { type: 'noRepository' }
  | { type: 'loading'; value: boolean }
  | { type: 'details'; requestId: number; commits: CommitDetails[]; changeSet: ChangeSetView }
  | { type: 'revealCommit'; hash: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'fetch' }
  | { type: 'selectRepository'; root: string }
  | { type: 'setFocus'; revisions: string[] }
  | { type: 'toggleFavorite'; fullName: string }
  /** Hashes in log order, newest first. */
  | { type: 'selectCommits'; requestId: number; hashes: string[] }
  | { type: 'fileAction'; action: FileAction; changeSetId: number; index: number }
  | { type: 'commitAction'; action: CommitAction; hash: string }
  | { type: 'refAction'; action: RefAction; fullName: string }
  | { type: 'openWorktree'; path: string; newWindow: boolean }
  | { type: 'showStash'; requestId: number; hash: string };
