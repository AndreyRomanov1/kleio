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
  /** File to select when the set is shown, e.g. the traced file in a history view. */
  focusIndex?: number;
}

export type CommitAction =
  | 'checkout'
  | 'newBranch'
  | 'newTag'
  | 'revert'
  | 'copyHash'
  | 'copySubject'
  | 'compareWithWorktree'
  | 'openInHosting'
  | 'copyHostingLink';

export type RefAction =
  | 'checkout'
  | 'newBranch'
  | 'deleteBranch'
  | 'deleteRemoteBranch'
  | 'fetchBranch'
  | 'showDiffWithCurrent'
  | 'copyName'
  | 'openInHosting'
  | 'createMergeRequest';

/** What the log knows about the hosting of the repository; sent after the snapshot, as it needs the network. */
export interface HostingView {
  /** `GitLab` or `GitHub`; undefined when the remote is not a known hosting. */
  name?: string;
  /** Commit → numbers of merge requests whose head it is; servers keep these refs for open and recently closed ones. */
  mergeRequests: Record<string, number[]>;
  /** Branch merge requests target, e.g. `origin/master`. */
  defaultBranch?: string;
  /** Local branches already merged into the default branch. */
  merged: string[];
  /** Rules turning text of commit messages into links. */
  autolinks: { pattern: string; url: string }[];
}

export type FileAction = 'openDiff' | 'openCurrent' | 'openRevision' | 'compareWithWorktree' | 'copyPath';

export type HostMessage =
  | {
      type: 'snapshot';
      repositories: RepositoryInfo[];
      snapshot: RepositorySnapshot;
      focus: string[];
      favorites: string[];
      /** Set when the view shows the history of a file or of lines instead of the whole log. */
      history?: { title: string };
    }
  | { type: 'noRepository' }
  | { type: 'loading'; value: boolean }
  | { type: 'details'; requestId: number; commits: CommitDetails[]; changeSet: ChangeSetView }
  | { type: 'revealCommit'; hash: string }
  | { type: 'hosting'; hosting: HostingView };

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
  | { type: 'openUrl'; url: string }
  | { type: 'openMergeRequest'; number: number }
  /** Double click on a commit: its diff, or in a history view the diff of the file in that commit. */
  | { type: 'openCommitDiff'; hash: string }
  | { type: 'showStash'; requestId: number; hash: string };
