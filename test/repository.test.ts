import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  work = mkdtempSync(path.join(tmpdir(), 'kleio-repo-'));
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

  it('commits only selected files, including a new one, and rolls back the rest', async () => {
    const dir = path.join(work, 'commit');
    git(work, 'init', '-q', '-b', 'main', dir);
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'user.email', 't@x');
    commitFile(dir, 'a.txt', 'a\n', 'init');
    commitFile(dir, 'b.txt', 'b\n', 'init b');
    writeFileSync(path.join(dir, 'a.txt'), 'a2\n');
    writeFileSync(path.join(dir, 'b.txt'), 'b2\n');
    writeFileSync(path.join(dir, 'new.txt'), 'n\n');
    writeFileSync(path.join(dir, 'other.txt'), 'o\n');
    const repository = (await Repository.open(dir))!;

    const before = await repository.workingChanges();
    expect(before.tracked.map((c) => c.path)).toEqual(['a.txt', 'b.txt']);
    expect(before.untracked).toEqual(['new.txt', 'other.txt']);

    await repository.commitFiles({
      message: 'only a and new\n\nbody',
      paths: ['a.txt'],
      untracked: ['new.txt'],
      amend: false,
    });
    expect(git(dir, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n')).toEqual([
      'only a and new',
      '',
      'a.txt',
      'new.txt',
    ]);
    const after = await repository.workingChanges();
    expect(after.tracked.map((c) => c.path)).toEqual(['b.txt']);
    expect(after.untracked).toEqual(['other.txt']);

    await repository.commitFiles({ message: 'renamed message', paths: [], untracked: [], amend: true });
    expect(await repository.lastCommitMessage()).toBe('renamed message');
    expect((await repository.workingChanges()).tracked.map((c) => c.path)).toEqual(['b.txt']);

    await repository.rollback(['b.txt']);
    expect((await repository.workingChanges()).tracked).toEqual([]);
    expect(await repository.recentMessages()).toEqual(['renamed message', 'init b', 'init']);
  });

  it('commits chosen hunks of a file and keeps the rest and the staged changes of others', async () => {
    const dir = path.join(work, 'hunks');
    git(work, 'init', '-q', '-b', 'main', dir);
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'user.email', 't@x');
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    commitFile(dir, 'a.txt', lines.join('\n') + '\n', 'init');
    commitFile(dir, 'staged.txt', 's\n', 'staged');
    const changed = [...lines];
    changed[1] = 'line 2 changed';
    changed[6] = 'line 7 changed';
    changed[17] = 'line 18 changed';
    writeFileSync(path.join(dir, 'a.txt'), changed.join('\n') + '\n');
    writeFileSync(path.join(dir, 'staged.txt'), 's staged\n');
    git(dir, 'add', 'staged.txt');
    writeFileSync(path.join(dir, 'new.txt'), 'new\n');
    const repository = (await Repository.open(dir))!;

    const patch = await repository.workingPatch('a.txt');
    expect(patch.hunks).toHaveLength(3);
    await repository.commitFiles({
      message: 'lines 7 and 18',
      paths: [],
      untracked: ['new.txt'],
      amend: false,
      hunks: { 'a.txt': [patch.hunks[1].key, patch.hunks[2].key] },
    });

    expect(git(dir, 'show', 'HEAD:a.txt').split('\n')[1]).toBe('line 2');
    expect(git(dir, 'show', 'HEAD:a.txt').split('\n')[6]).toBe('line 7 changed');
    expect(git(dir, 'show', 'HEAD:a.txt').split('\n')[17]).toBe('line 18 changed');
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual([
      'a.txt',
      'new.txt',
    ]);
    expect(git(dir, 'diff', '--name-only').trim()).toBe('a.txt');
    expect(git(dir, 'diff', '-U0', 'a.txt')).toContain('+line 2 changed');
    expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('staged.txt');

    await expect(
      repository.commitFiles({
        message: 'x',
        paths: [],
        untracked: [],
        amend: false,
        hunks: { 'a.txt': ['gone'] },
      }),
    ).rejects.toThrow(/изменился/);
  });

  it('commits a later hunk while skipping an earlier one that adds lines', async () => {
    const dir = path.join(work, 'hunks-shift');
    git(work, 'init', '-q', '-b', 'main', dir);
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'user.email', 't@x');
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    commitFile(dir, 'a.txt', lines.join('\n') + '\n', 'init');
    const changed = [...lines.slice(0, 2), 'new A', 'new B', ...lines.slice(2)];
    changed[9] = 'line 8 changed';
    changed.splice(12, 1);
    writeFileSync(path.join(dir, 'a.txt'), changed.join('\n') + '\n');
    const repository = (await Repository.open(dir))!;

    const patch = await repository.workingPatch('a.txt');
    expect(patch.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [2, 0, 3, 2],
      [8, 1, 10, 1],
      [11, 1, 12, 0],
    ]);
    await repository.commitFiles({
      message: 'only line 8 and the removal',
      paths: [],
      untracked: [],
      amend: false,
      hunks: { 'a.txt': [patch.hunks[1].key, patch.hunks[2].key] },
    });
    const expected = [...lines];
    expected[7] = 'line 8 changed';
    expected.splice(10, 1);
    expect(git(dir, 'show', 'HEAD:a.txt')).toBe(expected.join('\n') + '\n');
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(changed.join('\n') + '\n');
  });

  it('rolls back chosen hunks of a file and keeps its other changes', async () => {
    const dir = path.join(work, 'hunks-rollback');
    git(work, 'init', '-q', '-b', 'main', dir);
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    commitFile(dir, 'a.txt', lines.join('\n') + '\n', 'init');
    const changed = ['line 1', 'added', ...lines.slice(1)];
    changed[8] = 'line 8 changed';
    writeFileSync(path.join(dir, 'a.txt'), changed.join('\n') + '\n');
    const repository = (await Repository.open(dir))!;

    const patch = await repository.workingPatch('a.txt');
    await repository.rollbackHunks('a.txt', [patch.hunks[0].key]);
    const expected = [...lines];
    expected[7] = 'line 8 changed';
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(expected.join('\n') + '\n');
  });

  it('stages and unstages hunks and commits only what is staged', async () => {
    const dir = path.join(work, 'staging');
    git(work, 'init', '-q', '-b', 'main', dir);
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    commitFile(dir, 'a.txt', lines.join('\n') + '\n', 'init');
    const changed = [...lines];
    changed[1] = 'line 2 changed';
    changed[17] = 'line 18 changed';
    writeFileSync(path.join(dir, 'a.txt'), changed.join('\n') + '\n');
    writeFileSync(path.join(dir, 'new.txt'), 'new\n');
    const repository = (await Repository.open(dir))!;

    const unstaged = await repository.unstagedPatch('a.txt');
    expect(unstaged.hunks).toHaveLength(2);
    await repository.stageHunks('a.txt', [unstaged.hunks[1].key], true);
    await repository.stage(['new.txt'], true);
    let state = await repository.stagingState();
    expect([...state.staged].sort()).toEqual(['a.txt', 'new.txt']);
    expect([...state.unstaged]).toEqual(['a.txt']);

    await repository.stage(['new.txt'], false);
    const staged = await repository.stagedPatch('a.txt');
    expect(staged.hunks).toHaveLength(1);
    await repository.rollbackHunks('a.txt', [(await repository.unstagedPatch('a.txt')).hunks[0].key], true);
    await repository.commitIndex('line 18', false);

    expect(git(dir, 'show', 'HEAD:a.txt').split('\n')[17]).toBe('line 18 changed');
    expect(git(dir, 'show', 'HEAD:a.txt').split('\n')[1]).toBe('line 2');
    state = await repository.stagingState();
    expect(state.staged.size + state.unstaged.size).toBe(0);
    expect(git(dir, 'status', '--porcelain')).toBe('?? new.txt\n');
  });
});
