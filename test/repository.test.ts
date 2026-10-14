import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UNCOMMITTED } from '../src/extension/git/parse';
import { Repository, WORKTREE } from '../src/extension/git/repository';

let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@x',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@x',
    },
  });
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'grove-repo-'));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('Repository', () => {
  it('detects a branch that was rebased on the server as having no unique commits', async () => {
    const server = path.join(work, 'server.git');
    const local = path.join(work, 'local');
    const other = path.join(work, 'other');
    git(work, 'init', '-q', '--bare', '-b', 'main', server);
    git(work, 'clone', '-q', server, local);
    commitFile(local, 'base.txt', 'base\n', 'base');
    git(local, 'push', '-q', 'origin', 'main');
    git(local, 'checkout', '-q', '-b', 'feature');
    commitFile(local, 'f1.txt', 'one\n', 'feature 1');
    commitFile(local, 'f2.txt', 'two\n', 'feature 2');
    git(local, 'push', '-q', '-u', 'origin', 'feature');

    git(work, 'clone', '-q', server, other);
    commitFile(other, 'main.txt', 'main\n', 'main moves on');
    git(other, 'push', '-q', 'origin', 'main');
    git(other, 'checkout', '-q', 'feature');
    git(other, 'rebase', '-q', 'origin/main');
    git(other, 'push', '-q', '--force', 'origin', 'feature');

    git(local, 'fetch', '-q');
    const repository = (await Repository.open(local))!;

    expect(await repository.aheadBehind('feature', 'origin/feature')).toEqual({ ahead: 2, behind: 3 });
    expect(await repository.uniqueCommits('origin/feature', 'feature')).toEqual([]);

    commitFile(local, 'local.txt', 'mine\n', 'local only');
    const unique = await repository.uniqueCommits('origin/feature', 'feature');
    expect(unique).toHaveLength(1);
    expect(unique[0]).toBe(git(local, 'rev-parse', 'HEAD').trim());

    const snapshot = await repository.snapshot();
    expect(snapshot.head.branch).toBe('feature');
    expect(snapshot.refs.find((r) => r.name === 'feature')).toMatchObject({ ahead: 3, behind: 3 });
  });

  it('lists changes and hunks of a commit, of a root commit and against the working tree', async () => {
    const dir = path.join(work, 'changes');
    git(work, 'init', '-q', '-b', 'main', dir);
    commitFile(dir, 'a.txt', 'a\nb\nc\n', 'root');
    commitFile(dir, 'a.txt', 'a\nB\nc\n', 'change b');
    const repository = (await Repository.open(dir))!;
    const head = await repository.commitDetails('HEAD');

    expect(await repository.changes(undefined, head.parents[0])).toEqual([{ status: 'A', path: 'a.txt' }]);
    expect(await repository.changes(head.parents[0], head.hash)).toEqual([{ status: 'M', path: 'a.txt' }]);
    expect(await repository.hunks(head.parents[0], head.hash, { status: 'M', path: 'a.txt' })).toEqual([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
    ]);

    writeFileSync(path.join(dir, 'a.txt'), 'a\nB\nc\nd\n');
    expect(await repository.changes('HEAD', WORKTREE)).toEqual([{ status: 'M', path: 'a.txt' }]);
    expect(await repository.blobHash('HEAD', 'a.txt')).not.toBe(await repository.worktreeBlobHash('a.txt'));
  });

  it('blames unsaved contents and follows a file through a rename in its history', async () => {
    const dir = path.join(work, 'history');
    git(work, 'init', '-q', '-b', 'main', dir);
    commitFile(dir, 'old.txt', 'one\ntwo\nthree\n', 'add');
    git(dir, 'mv', 'old.txt', 'new.txt');
    git(dir, 'commit', '-q', '-m', 'rename');
    commitFile(dir, 'new.txt', 'one\nTWO\nthree\n', 'change two');
    const repository = (await Repository.open(dir))!;

    const blame = await repository.blame('new.txt', { contents: 'one\nTWO\nthree\nfour\n' });
    expect(blame.map((l) => (l.commit.hash === UNCOMMITTED ? 'uncommitted' : l.commit.summary))).toEqual([
      'add',
      'change two',
      'add',
      'uncommitted',
    ]);
    expect(blame[0].commit.filename).toBe('old.txt');

    const history = await repository.fileHistory('new.txt');
    expect(history.commits.map((c) => c.subject)).toEqual(['change two', 'rename', 'add']);
    expect(history.paths[history.commits[2].hash]).toBe('old.txt');

    const lines = await repository.lineHistory('new.txt', 2, 2);
    expect(lines.commits.map((c) => c.subject)).toEqual(['change two', 'add']);
    expect(lines.paths[lines.commits[1].hash]).toBe('old.txt');
  });
});
