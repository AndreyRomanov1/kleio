import type { FileChange } from './model';

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

/** One line of the plan, in the order git applies them (oldest first). */
export interface RebaseEntry {
  hash: string;
  action: RebaseAction;
  /** Final message of a commit that is kept; for a commit others are squashed into, the combined one. */
  message?: string;
}

export interface RebaseCommitView {
  hash: string;
  authorName: string;
  authorDate: number;
  message: string;
}

export type RebaseHostMessage =
  | {
      type: 'state';
      branch: string;
      /** Commit the rebased commits are put back onto; undefined when the range starts at the root. */
      base?: string;
      /** Oldest first. */
      commits: RebaseCommitView[];
      /** How the dialog starts, e.g. with commits picked for squashing next to each other. */
      initial: RebaseEntry[];
      /** Commit to select first, e.g. the one whose message is to be changed. */
      focus?: string;
      /** How many of the commits are already on a remote: rewriting them needs a force push. */
      published: number;
    }
  | { type: 'files'; hash: string; files: FileChange[] }
  | { type: 'busy'; value: boolean }
  | { type: 'error'; message: string };

export type RebaseWebviewMessage =
  | { type: 'ready' }
  | { type: 'selectCommit'; hash: string }
  | { type: 'openFile'; hash: string; index: number }
  | { type: 'start'; entries: RebaseEntry[] }
  | { type: 'cancel' };
