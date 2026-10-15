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
  | 'copyHostingLink'
  | 'cherryPick'
  | 'reset'
  | 'interactiveRebase'
  | 'reword'
  | 'fixupIntoParent';

export type RefAction =
  | 'checkout'
  | 'newBranch'
  | 'deleteBranch'
  | 'deleteRemoteBranch'
  | 'fetchBranch'
  | 'showDiffWithCurrent'
  | 'copyName'
  | 'openInHosting'
  | 'createMergeRequest'
  | 'merge'
  | 'rebaseOnto'
  | 'checkoutAndRebase'
  | 'checkoutToWorktree'
  | 'updateBranch'
  | 'push'
  | 'rename'
  | 'setUpstream'
  | 'pushTag'
  | 'deleteTag';

export type PipelineStatusView =
  | 'created'
  | 'waiting_for_resource'
  | 'preparing'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual'
  | 'scheduled';

export interface MergeRequestInfoView {
  title: string;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  draft: boolean;
}

export interface PipelineJobView {
  id: number;
  name: string;
  status: PipelineStatusView;
  duration?: number;
  allowFailure: boolean;
  /** Set for jobs of a child pipeline in another project. */
  projectId?: number;
  /** Set for a trigger job; `child` once its child pipeline has started. */
  bridge?: boolean;
  child?: { id: number; status: PipelineStatusView; webUrl: string; stages: PipelineStageView[] };
}

export interface PipelineStageView {
  name: string;
  jobs: PipelineJobView[];
}

export interface MergeRequestCardView {
  iid: number;
  title: string;
  state: MergeRequestInfoView['state'];
  draft: boolean;
  webUrl: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  hasConflicts: boolean;
  /** GitLab's merge readiness, e.g. `mergeable`, `not_approved`. */
  mergeStatus?: string;
  notes: number;
  reviewers: { name: string; approved: boolean }[];
  /** Other approvers who are not reviewers. */
  approvedBy: string[];
  approvalsLeft: number;
  pipeline?: {
    id: number;
    status: PipelineStatusView;
    webUrl: string;
    stages: PipelineStageView[];
  };
  discussions?: DiscussionsView;
  /** Whether this merge request is open for review in the diff viewer right now. */
  reviewing?: boolean;
  /** Whether the current GitLab user has approved it. */
  approvedByMe?: boolean;
}

export interface DiscussionsView {
  unresolved: number;
  /** Your pending comments, saved in GitLab and not yet published. */
  drafts: number;
  /** Comments on the merge request as a whole. */
  general: { author: string; body: string; createdAt: string; draft?: boolean }[];
  /** Threads on diff lines. `outdated` ones belong to an older version of the merge request. */
  threads: {
    path: string;
    line: number;
    author: string;
    body: string;
    replies: number;
    resolvable: boolean;
    resolved: boolean;
    outdated: boolean;
  }[];
}

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
  /** Whether merge request details and pipelines can be loaded, or the user should give access first. */
  api: 'none' | 'available' | 'needsAuth';
  mergeRequestInfo: Record<number, MergeRequestInfoView>;
  /** Commit → status of its latest pipeline. */
  pipelines: Record<string, PipelineStatusView>;
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
  | { type: 'hosting'; hosting: HostingView }
  /** Merged merge requests found through the API for older history; added to what `hosting` has. */
  | {
      type: 'mergedMergeRequests';
      byCommit: Record<string, number[]>;
      info: Record<number, MergeRequestInfoView>;
      coveredUntil?: number;
      done: boolean;
    }
  | {
      type: 'mergeRequestCard';
      number: number;
      card?: MergeRequestCardView;
      needsAuth?: boolean;
      error?: string;
    };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'fetch' }
  | { type: 'updateProject' }
  | { type: 'push' }
  /** Controls the merge or rebase that stopped half-way. */
  | { type: 'operation'; action: 'continue' | 'skip' | 'abort' | 'resolve' }
  | { type: 'selectRepository'; root: string }
  | { type: 'setFocus'; revisions: string[] }
  | { type: 'toggleFavorite'; fullName: string }
  /** Hashes in log order, newest first. */
  | { type: 'selectCommits'; requestId: number; hashes: string[] }
  | { type: 'fileAction'; action: FileAction; changeSetId: number; index: number }
  | { type: 'commitAction'; action: CommitAction; hash: string }
  /** Rewrites several commits of the current branch at once. */
  | { type: 'commitsAction'; action: 'squash' | 'drop' | 'cherryPick'; hashes: string[] }
  | { type: 'refAction'; action: RefAction; fullName: string }
  | { type: 'openWorktree'; path: string; newWindow: boolean }
  | { type: 'openUrl'; url: string }
  | { type: 'openMergeRequest'; number: number }
  | { type: 'loadMergeRequestCard'; number: number }
  /** The log reached commits from this moment (unix seconds): merge requests merged since are wanted. */
  | { type: 'loadMergedMergeRequests'; before: number }
  /** The log is scrolled to the end of a truncated history. */
  | { type: 'loadMoreCommits' }
  | { type: 'connectHosting'; number?: number }
  | { type: 'openJobLog'; jobId: number; name: string; projectId?: number }
  | { type: 'retryPipeline'; pipelineId: number; number: number }
  | { type: 'startReview'; number: number; path?: string; line?: number }
  | { type: 'postComment'; number: number; body: string; draft: boolean }
  | { type: 'publishDrafts'; number: number }
  | { type: 'approveMergeRequest'; number: number; approve: boolean }
  | { type: 'mergeMergeRequest'; number: number }
  | { type: 'rebaseMergeRequest'; number: number }
  | { type: 'playJob'; jobId: number; name: string; projectId?: number; number: number }
  /** Double click on a commit: its diff, or in a history view the diff of the file in that commit. */
  | { type: 'openCommitDiff'; hash: string }
  | { type: 'showStash'; requestId: number; hash: string };
