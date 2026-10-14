import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Commit,
  CommitDetails,
  FileChange,
  Head,
  OperationKind,
  OperationState,
  Ref,
  RepositorySnapshot,
  Stash,
} from '../../shared/model';
import { GitError, GitRunner } from './gitRunner';
import {
  FIELD,
  RECORD,
  HISTORY_FORMAT,
  LOG_FORMAT,
  parseBlame,
  parseHistory,
  parseHunks,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStashes,
  parseWorktrees,
  REF_FORMAT,
  STASH_FORMAT,
  type BlameLine,
  type FileHistory,
  type Hunk,
} from './parse';

/** Pseudo-revision for files on disk. */
export const WORKTREE = 'WORKTREE';

export interface WorkingChanges {
  tracked: FileChange[];
  untracked: string[];
  conflicted: string[];
}

/** How a merge, rebase or update ended. */
export type OperationOutcome = 'done' | 'conflicts' | 'stopped';

/** Commands that would open an editor for a message take the prepared one instead. */
const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };

export interface LogFilter {
  /** Revisions to show history of; all refs when empty. */
  revisions?: string[];
}

export class Repository {
  private emptyTree?: Promise<string>;

  private constructor(
    readonly root: string,
    /** The `.git` directory shared by all worktrees. */
    readonly commonDir: string,
    /** The `.git` directory of this worktree. */
    readonly gitDir: string,
    readonly git: GitRunner,
  ) {}

  static async open(folder: string): Promise<Repository | undefined> {
    const probe = new GitRunner(folder);
    let output: string;
    try {
      output = await probe.run([
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-common-dir',
        '--git-dir',
      ]);
    } catch {
      return undefined;
    }
    const [root, commonDir, gitDir] = output.trim().split('\n');
    if (!root) return undefined;
    return new Repository(path.normalize(root), commonDir, gitDir, new GitRunner(root));
  }

  get name(): string {
    return path.basename(this.root);
  }

  async snapshot(filter: LogFilter = {}): Promise<RepositorySnapshot> {
    const revisions = filter.revisions?.length ? filter.revisions : ['--exclude=refs/stash', '--all'];
    const [log, refs, head, worktrees, stashes, operation] = await Promise.all([
      this.git.run(['log', '--date-order', `--format=${LOG_FORMAT}`, ...revisions, '--']),
      this.git.run(['for-each-ref', `--format=${REF_FORMAT}`]),
      this.head(),
      this.git.run(['worktree', 'list', '--porcelain']),
      this.git.run(['stash', 'list', `--format=${STASH_FORMAT}`]),
      this.operation(),
    ]);
    return {
      root: this.root,
      head,
      commits: parseLog(log),
      refs: parseRefs(refs),
      worktrees: parseWorktrees(worktrees, this.root),
      stashes: parseStashes(stashes),
      operation,
    };
  }

  async head(): Promise<Head> {
    const [hash, branch] = await Promise.all([
      this.git.run(['rev-parse', '-q', '--verify', 'HEAD'], { allowExitCodes: [1] }),
      this.git.run(['symbolic-ref', '-q', '--short', 'HEAD'], { allowExitCodes: [1] }),
    ]);
    return { hash: hash.trim() || undefined, branch: branch.trim() || undefined };
  }

  async commitDetails(hash: string): Promise<CommitDetails> {
    const format = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f');
    const output = await this.git.run(['show', '-s', `--format=${format}`, hash, '--']);
    const [h, parents, an, ae, at, cn, ce, ct, ...message] = output.split(FIELD);
    return {
      hash: h,
      parents: parents ? parents.split(' ') : [],
      authorName: an,
      authorEmail: ae,
      authorDate: Number(at),
      committerName: cn,
      committerEmail: ce,
      commitDate: Number(ct),
      message: message.join(FIELD).trimEnd(),
    };
  }

  /** Files changed between two revisions; `left` undefined means an empty tree. */
  async changes(left: string | undefined, right: string): Promise<FileChange[]> {
    const base = left ?? (await this.getEmptyTree());
    const args =
      right === WORKTREE
        ? ['diff', '--name-status', '-M', '-z', base, '--']
        : ['diff', '--name-status', '-M', '-z', base, right, '--'];
    return parseNameStatus(await this.git.run(args));
  }

  async hunks(left: string | undefined, right: string, change: FileChange): Promise<Hunk[]> {
    const base = left ?? (await this.getEmptyTree());
    const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
    const revisions = right === WORKTREE ? [base] : [base, right];
    const output = await this.git.run(['diff', '-U0', '-M', '--no-ext-diff', ...revisions, '--', ...paths]);
    return parseHunks(output);
  }

  showFile(revision: string, filePath: string): Promise<Buffer> {
    return this.git.runBuffer(['show', `${revision}:${filePath}`]);
  }

  async blobHash(revision: string, filePath: string): Promise<string | undefined> {
    const output = await this.git.run(['rev-parse', '-q', '--verify', `${revision}:${filePath}`], {
      allowExitCodes: [1, 128],
    });
    return output.trim() || undefined;
  }

  async worktreeBlobHash(filePath: string): Promise<string | undefined> {
    try {
      return (await this.git.run(['hash-object', '--', filePath])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async revParse(revision: string): Promise<string | undefined> {
    const output = await this.git.run(['rev-parse', '-q', '--verify', `${revision}^{commit}`], {
      allowExitCodes: [1, 128],
    });
    return output.trim() || undefined;
  }

  async aheadBehind(left: string, right: string): Promise<{ ahead: number; behind: number }> {
    const output = await this.git.run(['rev-list', '--left-right', '--count', `${left}...${right}`]);
    const [ahead, behind] = output.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  }

  /** Commits of `branch` absent from `upstream` even as an equivalent patch (e.g. after a rebase). */
  async uniqueCommits(upstream: string, branch: string): Promise<string[]> {
    const output = await this.git.run(['cherry', upstream, branch]);
    return output
      .split('\n')
      .filter((line) => line.startsWith('+ '))
      .map((line) => line.slice(2));
  }

  /**
   * Blames a file at a revision, or the given unsaved contents of the working file when `revision` is omitted.
   */
  async blame(
    filePath: string,
    options: { revision?: string; contents?: string } = {},
  ): Promise<BlameLine[]> {
    const args = ['blame', '--porcelain'];
    if (options.revision) args.push(options.revision);
    else if (options.contents !== undefined) args.push('--contents', '-');
    args.push('--', filePath);
    return parseBlame(await this.git.run(args, { input: options.contents }));
  }

  /** Commits that changed the file, following renames. */
  async fileHistory(filePath: string): Promise<FileHistory> {
    const output = await this.git.run([
      'log',
      '--follow',
      '--name-status',
      `--format=${HISTORY_FORMAT}`,
      '--',
      filePath,
    ]);
    return parseHistory(output);
  }

  /** Commits that changed the given lines (1-based, inclusive) of the file. */
  async lineHistory(filePath: string, start: number, end: number): Promise<FileHistory> {
    const output = await this.git.run(['log', `-L${start},${end}:${filePath}`, `--format=${HISTORY_FORMAT}`]);
    return parseHistory(output);
  }

  /** Uncommitted changes relative to HEAD, unversioned files and files with merge conflicts. */
  async workingChanges(): Promise<WorkingChanges> {
    const hasHead = (await this.head()).hash !== undefined;
    const [tracked, untracked, conflicted] = await Promise.all([
      hasHead
        ? this.changes('HEAD', WORKTREE)
        : this.git.run(['diff', '--cached', '--name-status', '-z']).then(parseNameStatus),
      this.git.run(['ls-files', '--others', '--exclude-standard', '-z']),
      this.git.run(['diff', '--name-only', '--diff-filter=U', '-z']),
    ]);
    return {
      tracked,
      untracked: untracked.split('\0').filter(Boolean),
      conflicted: conflicted.split('\0').filter(Boolean),
    };
  }

  /**
   * Commits only the given files, leaving other changes (staged or not) as they are. Unversioned files are
   * added with intent-to-add first, so that `commit --only` picks them up.
   */
  async commitFiles(options: {
    message: string;
    paths: string[];
    untracked: string[];
    amend: boolean;
  }): Promise<void> {
    if (options.untracked.length) await this.git.run(['add', '--intent-to-add', '--', ...options.untracked]);
    const args = ['commit', '--only', '--cleanup=strip', '-F', '-'];
    if (options.amend) args.push('--amend');
    const paths = [...options.paths, ...options.untracked];
    if (paths.length) args.push('--', ...paths);
    await this.git.run(args, { input: options.message });
  }

  /** Discards changes of tracked files, including newly added ones. */
  async rollback(paths: string[]): Promise<void> {
    if (paths.length)
      await this.git.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths]);
  }

  async stashSave(message: string, includeUntracked: boolean): Promise<void> {
    const args = ['stash', 'push'];
    if (includeUntracked) args.push('--include-untracked');
    if (message.trim()) args.push('-m', message.trim());
    await this.git.run(args);
  }

  async stashApply(selector: string, pop: boolean): Promise<void> {
    await this.git.run(['stash', pop ? 'pop' : 'apply', selector]);
  }

  async stashDrop(selector: string): Promise<void> {
    await this.git.run(['stash', 'drop', selector]);
  }

  async stashes(): Promise<Stash[]> {
    return parseStashes(await this.git.run(['stash', 'list', `--format=${STASH_FORMAT}`]));
  }

  /** The merge, rebase, cherry-pick or revert this worktree is in the middle of, if any. */
  async operation(): Promise<OperationState | undefined> {
    const read = (file: string) =>
      readFile(path.join(this.gitDir, file), 'utf8').then(
        (text) => text.trim(),
        () => undefined,
      );
    const [rebaseMerge, rebaseApply, merge, pick, revert] = await Promise.all([
      read('rebase-merge/head-name'),
      read('rebase-apply/head-name'),
      read('MERGE_HEAD'),
      read('CHERRY_PICK_HEAD'),
      read('REVERT_HEAD'),
    ]);
    let state: Omit<OperationState, 'conflicted'> | undefined;
    if (rebaseMerge !== undefined || rebaseApply !== undefined) {
      const dir = rebaseMerge !== undefined ? 'rebase-merge' : 'rebase-apply';
      const [onto, step, total, stopped] = await Promise.all([
        read(`${dir}/onto`),
        read(dir === 'rebase-merge' ? `${dir}/msgnum` : `${dir}/next`),
        read(dir === 'rebase-merge' ? `${dir}/end` : `${dir}/last`),
        read(`${dir}/stopped-sha`),
      ]);
      const headName = rebaseMerge ?? rebaseApply;
      state = {
        kind: 'rebase',
        branch: headName?.startsWith('refs/heads/') ? headName.slice('refs/heads/'.length) : undefined,
        onto,
        step: step ? Number(step) : undefined,
        total: total ? Number(total) : undefined,
        stoppedAt: stopped || undefined,
      };
    } else if (merge !== undefined) {
      state = { kind: 'merge', onto: merge.split('\n')[0] };
    } else if (pick !== undefined) {
      state = { kind: 'cherry-pick', onto: pick };
    } else if (revert !== undefined) {
      state = { kind: 'revert', onto: revert };
    }
    if (!state) return undefined;
    const conflicted = await this.git.run(['diff', '--name-only', '--diff-filter=U', '-z']);
    return { ...state, conflicted: conflicted.split('\0').filter(Boolean) };
  }

  /**
   * Merges a revision into the current branch. Uncommitted changes are stashed for the time of the merge and
   * brought back after it, as Rider does.
   */
  merge(
    revision: string,
    options: { noFastForward?: boolean; fastForwardOnly?: boolean; squash?: boolean } = {},
  ): Promise<OperationOutcome> {
    const args = ['merge', '--autostash'];
    if (options.noFastForward) args.push('--no-ff');
    if (options.fastForwardOnly) args.push('--ff-only');
    if (options.squash) args.push('--squash');
    return this.runOperation([...args, revision]);
  }

  /** Rebases the current branch onto a revision, stashing uncommitted changes for the time of it. */
  rebase(onto: string): Promise<OperationOutcome> {
    return this.runOperation(['rebase', '--autostash', onto]);
  }

  cherryPick(hash: string): Promise<OperationOutcome> {
    return this.runOperation(['cherry-pick', hash]);
  }

  /** Goes on with the stopped operation once its conflicts are resolved, keeping the prepared message. */
  async continueOperation(kind: OperationKind): Promise<OperationOutcome> {
    return this.runOperation([kind, '--continue']);
  }

  /** Skips the commit the rebase or cherry-pick stopped at. */
  skipOperation(kind: OperationKind): Promise<OperationOutcome> {
    return this.runOperation([kind, '--skip']);
  }

  async abortOperation(kind: OperationKind): Promise<void> {
    await this.git.run([kind, '--abort'], { env: NO_EDITOR });
  }

  /**
   * Runs a command that may stop half-way. A stop for conflicts or for an edit is a normal outcome, not an
   * error; any other failure, e.g. local changes in the way, is thrown.
   */
  private async runOperation(args: string[]): Promise<OperationOutcome> {
    try {
      await this.git.run(args, { env: NO_EDITOR });
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      const state = await this.operation();
      if (state?.conflicted.length) return 'conflicts';
      throw error;
    }
    const state = await this.operation();
    if (!state) return 'done';
    return state.conflicted.length ? 'conflicts' : 'stopped';
  }

  /**
   * Moves a branch that is not checked out to a new commit, but only if it still points where it did when
   * the caller looked at it.
   */
  async moveBranch(branch: string, to: string, from: string): Promise<void> {
    await this.git.run(['update-ref', '-m', `grove: update ${branch}`, `refs/heads/${branch}`, to, from]);
  }

  async reset(revision: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    await this.git.run(['reset', `--${mode}`, revision]);
  }

  /** Commits of `branch` not yet on its remote: after `upstream`, or after every remote branch when it has none. */
  async outgoing(branch: string, upstream: string | undefined): Promise<Commit[]> {
    const range = upstream ? [`${upstream}..${branch}`] : [branch, '--not', '--remotes'];
    return parseLog(await this.git.run(['log', `--format=${LOG_FORMAT}`, '-n500', ...range, '--']));
  }

  async lastCommitMessage(): Promise<string> {
    return (await this.git.run(['log', '-1', '--format=%B'])).trimEnd();
  }

  /** Subjects of the latest commits by the configured user, for the commit message history. */
  async recentMessages(limit = 30): Promise<string[]> {
    const email = (await this.git.run(['config', 'user.email'], { allowExitCodes: [1] })).trim();
    const args = ['log', `-n${limit}`, '--format=%B%x1e'];
    if (email) args.push(`--author=${email}`);
    const output = await this.git.run(args);
    return output
      .split(RECORD)
      .map((m) => m.trim())
      .filter(Boolean);
  }

  /** Local branches whose commits are all in `target`. */
  async mergedBranches(target: string): Promise<string[]> {
    const output = await this.git.run(['branch', '--merged', target, '--format=%(refname:short)']);
    return output.split('\n').filter(Boolean);
  }

  async refs(): Promise<Ref[]> {
    return parseRefs(await this.git.run(['for-each-ref', `--format=${REF_FORMAT}`]));
  }

  private getEmptyTree(): Promise<string> {
    this.emptyTree ??= this.git
      .run(['hash-object', '-t', 'tree', '--stdin'], { input: '' })
      .then((h) => h.trim());
    return this.emptyTree;
  }
}
