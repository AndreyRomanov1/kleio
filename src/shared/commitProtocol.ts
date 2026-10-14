import type { ChangeStatus, Stash } from './model';

export type CommitFileKind = 'tracked' | 'untracked' | 'conflict';

export interface CommitFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus | '?';
  kind: CommitFileKind;
}

export type CommitHostMessage =
  | { type: 'state'; branch?: string; files: CommitFile[]; stashes: Stash[] }
  | { type: 'noRepository' }
  | { type: 'busy'; value: boolean }
  | { type: 'amendMessage'; message: string }
  | { type: 'recentMessages'; messages: string[] }
  /** The commit went through: the message box is cleared. */
  | { type: 'committed' };

export type CommitWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openDiff'; path: string }
  | { type: 'openFile'; path: string }
  | { type: 'rollback'; paths: string[] }
  | { type: 'commit'; message: string; paths: string[]; amend: boolean; push: boolean }
  | { type: 'requestAmendMessage' }
  | { type: 'requestRecentMessages' }
  | { type: 'stashSave'; message: string; includeUntracked: boolean }
  | { type: 'stashAction'; action: 'show' | 'apply' | 'pop' | 'drop'; selector: string; hash: string };
