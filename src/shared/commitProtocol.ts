import type { ChangeStatus, Stash } from './model';

export type CommitFileKind = 'tracked' | 'untracked' | 'conflict';

export interface CommitFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus | '?';
  kind: CommitFileKind;
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
}

export type CommitHostMessage =
  | { type: 'state'; branch?: string; files: CommitFile[]; stashes: Stash[] }
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
  | { type: 'requestAmendMessage' }
  | { type: 'requestRecentMessages' }
  | { type: 'stashSave'; message: string; includeUntracked: boolean }
  | { type: 'stashAction'; action: 'show' | 'apply' | 'pop' | 'drop'; selector: string; hash: string };
