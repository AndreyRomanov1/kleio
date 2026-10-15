import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import type { ConflictFileView } from '../../shared/conflictsProtocol';
import type { RebaseEntry } from '../../shared/rebaseProtocol';
import { GitError, GitRunner } from './gitRunner';
import { parseFilePatch, selectHunks, type FilePatch } from './patch';
import { buildRebaseTodo } from './rebasePlan';
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
import { t } from '../../shared/l10n';

/** Pseudo-revision for files on disk. */
export const WORKTREE = 'WORKTREE';

export interface WorkingChanges {
  tracked: FileChange[];
  untracked: string[];
  conflicted: string[];
}

/**
 * How a merge, rebase or update ended. `stash-conflicts`: the operation itself is done, but the uncommitted
 * changes stashed for its time came back with conflicts, and their copy is left in the stash.
 */
export type OperationOutcome = 'done' | 'conflicts' | 'stopped' | 'stash-conflicts';

/** Commands that would open an editor for a message take the prepared one instead. */
const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };

export interface LogFilter {
  /** Revisions to show history of; all refs when empty. */
  revisions?: string[];
  /** At most this many newest commits. */
  limit?: number;
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
      this.git.run([
        'log',
        '--date-order',
        `--format=${LOG_FORMAT}`,
        ...(filter.limit ? [`-n${filter.limit + 1}`] : []),
        ...revisions,
        '--',
      ]),
      this.git.run(['for-each-ref', `--format=${REF_FORMAT}`]),
      this.head(),
      this.git.run(['worktree', 'list', '--porcelain']),
      this.git.run(['stash', 'list', `--format=${STASH_FORMAT}`]),
      this.operation(),
    ]);
    const commits = parseLog(log);
    const truncated = filter.limit !== undefined && commits.length > filter.limit;
    return {
      root: this.root,
      head,
      commits: truncated ? commits.slice(0, filter.limit) : commits,
      truncated,
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
   * Uncommitted changes of a tracked file against HEAD, split into hunks without context lines, so that every
   * change the diff editor shows is a hunk of its own (with context, git glues changes a few lines apart).
   */
  async workingPatch(filePath: string): Promise<FilePatch> {
    return parseFilePatch(
      await this.git.run(['diff', '--no-ext-diff', '--no-color', '-U0', 'HEAD', '--', filePath]),
    );
  }

  /**
   * Commits only the given files, leaving other changes (staged or not) as they are. Unversioned files are
   * added with intent-to-add first, so that `commit --only` picks them up.
   *
   * With `hunks`, parts of files are committed: the commit is built in a temporary index from HEAD, the whole
   * files and the chosen hunks are put there, and `git commit` (with its hooks) commits that index. The index
   * of the user is then brought up to date only for the committed paths.
   */
  async commitFiles(options: {
    message: string;
    paths: string[];
    untracked: string[];
    amend: boolean;
    /** File → keys of the hunks to commit, for files committed in part. */
    hunks?: Record<string, string[]>;
  }): Promise<void> {
    const partial = Object.entries(options.hunks ?? {});
    if (partial.length) return this.commitParts(options, partial);
    if (options.untracked.length) await this.git.run(['add', '--intent-to-add', '--', ...options.untracked]);
    const args = ['commit', '--only', '--cleanup=strip', '-F', '-'];
    if (options.amend) args.push('--amend');
    const paths = [...options.paths, ...options.untracked];
    if (paths.length) args.push('--', ...paths);
    await this.git.run(args, { input: options.message });
  }

  private async commitParts(
    options: { message: string; paths: string[]; untracked: string[]; amend: boolean },
    partial: [string, string[]][],
  ): Promise<void> {
    const patches = await Promise.all(
      partial.map(async ([filePath, keys]) => {
        const patch = await this.workingPatch(filePath);
        const known = new Set(patch.hunks.map((h) => h.key));
        if (keys.some((k) => !known.has(k)))
          throw new Error(t('File {0} has changed: check the chosen hunks and commit again.', filePath));
        return selectHunks(patch, new Set(keys));
      }),
    );
    const indexFile = path.join(this.gitDir, 'kleio-commit-index');
    const env = { GIT_INDEX_FILE: indexFile };
    await rm(indexFile, { force: true });
    try {
      await this.git.run(['read-tree', 'HEAD'], { env });
      const whole = [...options.paths, ...options.untracked];
      if (whole.length) await this.git.run(['add', '-A', '--', ...whole], { env });
      for (const patch of patches) {
        await this.git.run(['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'], {
          env,
          input: patch,
        });
      }
      const args = ['commit', '--cleanup=strip', '-F', '-'];
      if (options.amend) args.push('--amend');
      await this.git.run(args, { env, input: options.message });
    } finally {
      await rm(indexFile, { force: true });
    }
    const committed = [...options.paths, ...options.untracked, ...partial.map(([p]) => p)];
    await this.git.run(['reset', '-q', '--', ...committed]);
  }

  /** Staged changes of a file, split into hunks without context lines as {@link workingPatch} does. */
  async stagedPatch(filePath: string): Promise<FilePatch> {
    return parseFilePatch(
      await this.git.run(['diff', '--cached', '--no-ext-diff', '--no-color', '-U0', '--', filePath]),
    );
  }

  /** Changes of a file not staged yet: the working tree against the index. */
  async unstagedPatch(filePath: string): Promise<FilePatch> {
    return parseFilePatch(await this.git.run(['diff', '--no-ext-diff', '--no-color', '-U0', '--', filePath]));
  }

  /** Paths with staged changes and paths with changes not staged yet. */
  async stagingState(): Promise<{ staged: Set<string>; unstaged: Set<string> }> {
    const [staged, unstaged] = await Promise.all([
      this.git.run(['diff', '--cached', '--name-only', '--no-renames', '-z']),
      this.git.run(['diff', '--name-only', '--no-renames', '-z']),
    ]);
    const set = (output: string) => new Set(output.split('\0').filter(Boolean));
    return { staged: set(staged), unstaged: set(unstaged) };
  }

  /** Stages files as they are on disk, including deletions and new files, or takes them out of the index. */
  async stage(paths: string[], value: boolean): Promise<void> {
    if (!paths.length) return;
    if (value) await this.git.run(['add', '-A', '--', ...paths]);
    else await this.git.run(['reset', '-q', '--', ...paths]);
  }

  /** Stages hunks of {@link unstagedPatch}, or unstages hunks of {@link stagedPatch}. */
  async stageHunks(filePath: string, keys: string[], value: boolean): Promise<void> {
    const patch = value ? await this.unstagedPatch(filePath) : await this.stagedPatch(filePath);
    const known = new Set(patch.hunks.map((h) => h.key));
    if (keys.some((k) => !known.has(k)))
      throw new Error(t('File {0} has changed: refresh the list and try again.', filePath));
    const args = ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'];
    if (!value) args.push('-R');
    await this.git.run([...args, '-'], { input: selectHunks(patch, new Set(keys)) });
  }

  /** Commits what is staged, as plain `git commit` does. */
  async commitIndex(message: string, amend: boolean): Promise<void> {
    const args = ['commit', '--cleanup=strip', '-F', '-'];
    if (amend) args.push('--amend');
    await this.git.run(args, { input: message });
  }

  /**
   * Discards the given hunks of a file in the working tree, keeping its other changes. The hunks are those of
   * {@link workingPatch}, or of {@link unstagedPatch} with `unstagedOnly`.
   */
  async rollbackHunks(filePath: string, keys: string[], unstagedOnly = false): Promise<void> {
    const patch = unstagedOnly ? await this.unstagedPatch(filePath) : await this.workingPatch(filePath);
    const known = new Set(patch.hunks.map((h) => h.key));
    if (keys.some((k) => !known.has(k)))
      throw new Error(t('File {0} has changed: refresh the list and roll back again.', filePath));
    await this.git.run(['apply', '-R', '--unidiff-zero', '--whitespace=nowarn', '-'], {
      input: selectHunks(patch, new Set(keys)),
    });
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
      const [onto, step, total, stopped, rebaseHead] = await Promise.all([
        read(`${dir}/onto`),
        read(dir === 'rebase-merge' ? `${dir}/msgnum` : `${dir}/next`),
        read(dir === 'rebase-merge' ? `${dir}/end` : `${dir}/last`),
        read(`${dir}/stopped-sha`),
        read('REBASE_HEAD'),
      ]);
      const headName = rebaseMerge ?? rebaseApply;
      state = {
        kind: 'rebase',
        branch: headName?.startsWith('refs/heads/') ? headName.slice('refs/heads/'.length) : undefined,
        onto,
        step: step ? Number(step) : undefined,
        total: total ? Number(total) : undefined,
        stoppedAt: stopped || rebaseHead || undefined,
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

  /**
   * Rebases the current branch — or `branch`, checking it out first — onto a revision, stashing uncommitted
   * changes for the time of it.
   */
  rebase(onto: string, branch?: string): Promise<OperationOutcome> {
    return this.runOperation(['rebase', '--autostash', onto, ...(branch ? [branch] : [])]);
  }

  /**
   * Rewrites the commits after `base` (all of them up to the root when undefined) as planned in the dialog.
   * The todo list and the new messages are prepared up front, so git never opens an editor; they are kept in
   * the git directory, as the rebase may stop for conflicts or an edit and go on later.
   */
  async interactiveRebase(base: string | undefined, entries: RebaseEntry[]): Promise<OperationOutcome> {
    const originals = new Map<string, string>();
    for (const entry of entries) originals.set(entry.hash, (await this.commitDetails(entry.hash)).message);
    const dir = path.join(this.gitDir, 'kleio-rebase');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const { todo, messages } = buildRebaseTodo(entries, originals, (name) => path.join(dir, name));
    for (const [name, message] of messages) await writeFile(path.join(dir, name), message + '\n', 'utf8');
    const todoFile = path.join(dir, 'todo.txt');
    await writeFile(todoFile, todo, 'utf8');
    // Shell builtins only: external tools like `cp` may not start inside the editor's environment (an AppImage
    // puts its own libraries first), and git for Windows has the same shell.
    const source = `'${todoFile.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
    const copyTodo = `copy() { while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < ${source} > "$1"; }; copy`;
    return this.runOperation(['rebase', '-i', '--autostash', '--no-autosquash', base ?? '--root'], {
      GIT_SEQUENCE_EDITOR: copyTodo,
    });
  }

  /** Commits after `base` (from the root when undefined) up to HEAD, oldest first, with full messages. */
  async rebaseRange(base: string | undefined): Promise<{ commits: CommitDetails[]; merges: number }> {
    const range = base ? `${base}..HEAD` : 'HEAD';
    const [hashes, merges] = await Promise.all([
      this.git.run(['rev-list', '--reverse', '--no-merges', range]),
      this.git.run(['rev-list', '--count', '--merges', range]),
    ]);
    const commits = await Promise.all(
      hashes
        .split('\n')
        .filter(Boolean)
        .map((hash) => this.commitDetails(hash)),
    );
    return { commits, merges: Number(merges.trim()) };
  }

  /** Files with unresolved conflicts and which of the three versions (base, ours, theirs) each one has. */
  async conflicts(): Promise<ConflictFileView[]> {
    const output = await this.git.run(['ls-files', '--unmerged', '-z']);
    const files = new Map<string, ConflictFileView>();
    for (const record of output.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const stage = record.slice(0, tab).split(' ')[2];
      const filePath = record.slice(tab + 1);
      let file = files.get(filePath);
      if (!file) files.set(filePath, (file = { path: filePath, base: false, ours: false, theirs: false }));
      if (stage === '1') file.base = true;
      if (stage === '2') file.ours = true;
      if (stage === '3') file.theirs = true;
    }
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Resolves conflicts by taking one side; a side without the file resolves to deleting it. */
  async resolveConflicts(files: ConflictFileView[], side: 'ours' | 'theirs'): Promise<void> {
    const take = files.filter((f) => f[side]).map((f) => f.path);
    const remove = files.filter((f) => !f[side]).map((f) => f.path);
    if (take.length) {
      await this.git.run(['checkout', `--${side}`, '--', ...take]);
      await this.markResolved(take);
    }
    if (remove.length) await this.git.run(['rm', '--quiet', '--', ...remove]);
  }

  /**
   * Marks files as resolved with their current contents in the working tree. Outside of an operation the
   * conflicts come from bringing back stashed changes, which stay uncommitted, so the files are not staged.
   */
  async markResolved(paths: string[]): Promise<void> {
    if (!paths.length) return;
    if (await this.operation()) await this.git.run(['add', '--', ...paths]);
    else await this.git.run(['reset', '-q', '--', ...paths]);
  }

  /** Whether `ancestor` is reachable from `descendant`. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git.run(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return false;
      throw error;
    }
  }

  /** How many of the commits after `base` up to HEAD are already on some remote branch. */
  async publishedCount(base: string | undefined): Promise<number> {
    const range = base ? `${base}..HEAD` : 'HEAD';
    const [all, local] = await Promise.all([
      this.git.run(['rev-list', '--count', range]),
      this.git.run(['rev-list', '--count', range, '--not', '--remotes']),
    ]);
    return Number(all.trim()) - Number(local.trim());
  }

  /** Applies commits in the given order; a stop for conflicts leaves the rest to `--continue`. */
  cherryPick(...hashes: string[]): Promise<OperationOutcome> {
    return this.runOperation(['cherry-pick', ...hashes]);
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
  private async runOperation(args: string[], env: NodeJS.ProcessEnv = {}): Promise<OperationOutcome> {
    try {
      await this.git.run(args, { env: { ...NO_EDITOR, ...env } });
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      const state = await this.operation();
      if (state?.conflicted.length) return 'conflicts';
      throw error;
    }
    const state = await this.operation();
    if (state) return state.conflicted.length ? 'conflicts' : 'stopped';
    // git exits with 0 when the autostash does not apply cleanly.
    return (await this.conflicts()).length ? 'stash-conflicts' : 'done';
  }

  /** Drops the newest stash left by `--autostash`, once its changes are back in the working tree. */
  async dropAutostash(): Promise<boolean> {
    const entry = (await this.stashes()).find((s) => s.message === 'autostash');
    if (!entry) return false;
    await this.stashDrop(entry.selector);
    return true;
  }

  /**
   * Moves a branch that is not checked out to a new commit, but only if it still points where it did when
   * the caller looked at it.
   */
  async moveBranch(branch: string, to: string, from: string): Promise<void> {
    await this.git.run(['update-ref', '-m', `kleio: update ${branch}`, `refs/heads/${branch}`, to, from]);
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
