import type { ChangeStatus, Stash } from './model';

export type CommitFileKind = 'tracked' | 'untracked' | 'conflict';

export interface CommitFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus | '?';
  kind: CommitFileKind;
  /** How much of the file is staged; only when the view works with the staging area. */
  staged?: 'all' | 'some' | 'none';
}

/** A part of the uncommitted changes of a file that can be committed on its own. */
export interface HunkView {
  key: string;
  /** First line of the change in the working file, 1-based. */
  line: number;
  added: number;
  removed: number;
  /** The first changed lines, with `+` or `-`. */
  preview: string[];
  /** Whether the hunk is staged; only when the view works with the staging area. */
  staged?: boolean;
}

export type CommitHostMessage =
  | {
      type: 'state';
      branch?: string;
      files: CommitFile[];
      stashes: Stash[];
      /** Checkboxes show the staging area and the commit takes what is staged, as plain git does. */
      staging: boolean;
      root: string;
      /** All repositories, to switch between them when there are several. */
      repositories: { root: string; name: string }[];
    }
  | { type: 'noRepository' }
  | { type: 'busy'; value: boolean }
  | { type: 'amendMessage'; message: string }
  | { type: 'recentMessages'; messages: string[] }
  /** Hunks of a file, or none for a file that cannot be split (binary, renamed). */
  | { type: 'hunks'; path: string; hunks: HunkView[] }
  /** The commit went through: the message box is cleared. */
  | { type: 'committed' };

export type CommitWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openDiff'; path: string; line?: number }
  | { type: 'requestHunks'; path: string }
  | { type: 'openFile'; path: string }
  /** Whole files, and for files rolled back in part — the keys of their hunks. */
  | { type: 'rollback'; paths: string[]; hunks?: Record<string, string[]> }
  | {
      type: 'commit';
      message: string;
      /** Files committed whole. */
      paths: string[];
      /** Files committed in part: path → keys of the chosen hunks. */
      hunks: Record<string, string[]>;
      amend: boolean;
      push: boolean;
    }
  | { type: 'setStaging'; value: boolean }
  | { type: 'selectRepository'; root: string }
  /** With the staging area: stages or unstages whole files. */
  | { type: 'stage'; paths: string[]; value: boolean }
  /** With the staging area: stages or unstages a hunk. */
  | { type: 'stageHunk'; path: string; key: string; value: boolean }
  | { type: 'requestAmendMessage' }
  | { type: 'requestRecentMessages' }
  /** `paths` stashes only these files; all changes without it. */
  | { type: 'stashSave'; message: string; includeUntracked: boolean; paths?: string[] }
  | { type: 'stashAction'; action: 'show' | 'apply' | 'pop' | 'drop'; selector: string; hash: string };
