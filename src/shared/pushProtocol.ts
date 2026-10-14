import type { Commit, FileChange } from './model';

export interface PushBranchView {
  /** Local branch name. */
  branch: string;
  remote: string;
  /** Branch name on the remote. */
  target: string;
  /** Whether the branch already tracks a branch of the remote; otherwise the push sets it up. */
  hasUpstream: boolean;
  /** Whether the target branch exists on the remote already. */
  existsOnRemote: boolean;
  current: boolean;
  /** Commits of the remote branch missing locally: pushing then needs force. */
  behind: number;
  /** Force is never offered for these, e.g. `master`. */
  protected: boolean;
  commits: Commit[];
  checked: boolean;
}

export type PushHostMessage =
  | { type: 'state'; remotes: string[]; branches: PushBranchView[] }
  | { type: 'busy'; value: boolean }
  | { type: 'files'; hash: string; files: FileChange[] }
  | { type: 'error'; message: string };

export interface PushRequest {
  branch: string;
  remote: string;
  target: string;
  force: boolean;
}

export type PushWebviewMessage =
  | { type: 'ready' }
  | { type: 'selectCommit'; hash: string }
  | { type: 'openFile'; hash: string; index: number }
  | { type: 'push'; branches: PushRequest[] }
  | { type: 'cancel' };
