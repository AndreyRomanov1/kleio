import * as path from 'node:path';
import type { CommitDetails, FileChange, Head, RepositorySnapshot } from '../../shared/model';
import { GitRunner } from './gitRunner';
import {
  FIELD,
  LOG_FORMAT,
  parseHunks,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStashes,
  parseWorktrees,
  REF_FORMAT,
  STASH_FORMAT,
  type Hunk,
} from './parse';

/** Pseudo-revision for files on disk. */
export const WORKTREE = 'WORKTREE';

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
    const [log, refs, head, worktrees, stashes] = await Promise.all([
      this.git.run(['log', '--date-order', `--format=${LOG_FORMAT}`, ...revisions, '--']),
      this.git.run(['for-each-ref', `--format=${REF_FORMAT}`]),
      this.head(),
      this.git.run(['worktree', 'list', '--porcelain']),
      this.git.run(['stash', 'list', `--format=${STASH_FORMAT}`]),
    ]);
    return {
      root: this.root,
      head,
      commits: parseLog(log),
      refs: parseRefs(refs),
      worktrees: parseWorktrees(worktrees, this.root),
      stashes: parseStashes(stashes),
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

  private getEmptyTree(): Promise<string> {
    this.emptyTree ??= this.git
      .run(['hash-object', '-t', 'tree', '--stdin'], { input: '' })
      .then((h) => h.trim());
    return this.emptyTree;
  }
}
