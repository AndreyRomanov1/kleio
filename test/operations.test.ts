import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '../src/extension/git/repository';
import { matchesBranchPattern, pushArgs, readPushState, retarget } from '../src/extension/push/pushState';

let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function init(name: string): string {
  const dir = path.join(work, name);
  git(work, 'init', '-q', '-b', 'main', dir);
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'user.email', 't@x');
  return dir;
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

/** main and feature both change the first line of a.txt; feature also adds b.txt. */
function diverged(name: string): string {
  const dir = init(name);
  commitFile(dir, 'a.txt', 'base\n', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  commitFile(dir, 'b.txt', 'b\n', 'feature b');
  commitFile(dir, 'a.txt', 'feature\n', 'feature a');
  git(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'a.txt', 'main\n', 'main a');
  return dir;
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'kleio-ops-'));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('Repository operations', () => {
  it('stops a merge on conflicts, reports them and continues once they are resolved', async () => {
    const dir = diverged('merge');
    const repository = (await Repository.open(dir))!;

    expect(await repository.merge('feature')).toBe('conflicts');
    const state = await repository.operation();
    expect(state).toMatchObject({ kind: 'merge', conflicted: ['a.txt'] });
    expect(state?.onto).toBe(git(dir, 'rev-parse', 'feature').trim());

    expect(await repository.continueOperation('merge')).toBe('conflicts');
    writeFileSync(path.join(dir, 'a.txt'), 'both\n');
    git(dir, 'add', 'a.txt');
    expect(await repository.continueOperation('merge')).toBe('done');
    expect(await repository.operation()).toBeUndefined();
    expect(git(dir, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2);
  });

  it('aborts a merge and brings back uncommitted changes stashed for it', async () => {
    const dir = diverged('abort');
    writeFileSync(path.join(dir, 'local.txt'), 'untracked stays\n');
    commitFile(dir, 'c.txt', 'c\n', 'c');
    writeFileSync(path.join(dir, 'c.txt'), 'c changed\n');
    const repository = (await Repository.open(dir))!;

    expect(await repository.merge('feature')).toBe('conflicts');
    await repository.abortOperation('merge');
    expect(await repository.operation()).toBeUndefined();
    expect(readFileSync(path.join(dir, 'c.txt'), 'utf8')).toBe('c changed\n');
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('main\n');
  });

  it('rebases step by step through a conflict, skipping the conflicting commit', async () => {
    const dir = diverged('rebase');
    git(dir, 'checkout', '-q', 'feature');
    const repository = (await Repository.open(dir))!;

    expect(await repository.rebase('main')).toBe('conflicts');
    expect(await repository.operation()).toMatchObject({
      kind: 'rebase',
      branch: 'feature',
      step: 2,
      total: 2,
      conflicted: ['a.txt'],
    });
    expect(await repository.skipOperation('rebase')).toBe('done');
    expect(await repository.operation()).toBeUndefined();
    expect(git(dir, 'log', '--format=%s', 'main..feature').trim()).toBe('feature b');
    expect((await repository.head()).branch).toBe('feature');
  });

  it('checks out a branch and rebases it onto the current one', async () => {
    const dir = init('checkout-rebase');
    commitFile(dir, 'a.txt', 'a\n', 'a');
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitFile(dir, 'f.txt', 'f\n', 'f');
    git(dir, 'checkout', '-q', 'main');
    commitFile(dir, 'm.txt', 'm\n', 'm');
    const repository = (await Repository.open(dir))!;

    expect(await repository.rebase('main', 'feature')).toBe('done');
    expect((await repository.head()).branch).toBe('feature');
    expect(git(dir, 'log', '--format=%s', 'feature').trim().split('\n')).toEqual(['f', 'm', 'a']);
  });

  it('lists conflicts with the sides that have the file and resolves them by side', async () => {
    const dir = init('sides');
    commitFile(dir, 'a.txt', 'base\n', 'base a');
    commitFile(dir, 'gone.txt', 'base\n', 'base gone');
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitFile(dir, 'a.txt', 'feature\n', 'feature a');
    commitFile(dir, 'gone.txt', 'feature\n', 'feature gone');
    git(dir, 'checkout', '-q', 'main');
    commitFile(dir, 'a.txt', 'main\n', 'main a');
    git(dir, 'rm', '-q', 'gone.txt');
    git(dir, 'commit', '-q', '-m', 'main removes gone');
    const repository = (await Repository.open(dir))!;

    expect(await repository.merge('feature')).toBe('conflicts');
    const conflicts = await repository.conflicts();
    expect(conflicts).toEqual([
      { path: 'a.txt', base: true, ours: true, theirs: true },
      { path: 'gone.txt', base: true, ours: false, theirs: true },
    ]);

    await repository.resolveConflicts(conflicts, 'ours');
    expect(await repository.conflicts()).toEqual([]);
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('main\n');
    expect(git(dir, 'status', '--porcelain')).not.toContain('gone.txt\n?');
    expect(await repository.continueOperation('merge')).toBe('done');
    expect(git(dir, 'ls-files').trim().split('\n')).toEqual(['a.txt']);
  });

  it('merges without conflicts, keeping uncommitted changes of other files', async () => {
    const dir = init('clean');
    commitFile(dir, 'a.txt', 'a\n', 'a');
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitFile(dir, 'b.txt', 'b\n', 'b');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(path.join(dir, 'a.txt'), 'a changed\n');
    const repository = (await Repository.open(dir))!;

    expect(await repository.merge('feature')).toBe('done');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'feature'));
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a changed\n');
  });

  it('lists the reflog and returns the branch to an earlier state, keeping uncommitted changes', async () => {
    const dir = init('reflog');
    commitFile(dir, 'a.txt', 'a\n', 'a');
    commitFile(dir, 'b.txt', 'b\n', 'b');
    const before = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(path.join(dir, 'a.txt'), 'local\n');
    const repository = (await Repository.open(dir))!;

    const reflog = await repository.reflog();
    expect(reflog[0].action).toMatch(/^reset: moving to HEAD~1/);
    expect(reflog[1]).toMatchObject({ hash: before, subject: 'b' });
    expect(reflog[1].date).toBeGreaterThan(0);

    await repository.reset(reflog[1].hash, 'keep');
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('local\n');
  });

  it('saves commits as a patch and applies it as commits or as changes only', async () => {
    const source = init('patch-source');
    commitFile(source, 'a.txt', 'a\n', 'a');
    const base = git(source, 'rev-parse', 'HEAD').trim();
    commitFile(source, 'b.txt', 'b\n', 'add b');
    commitFile(source, 'a.txt', 'a2\n', 'change a');
    const hashes = git(source, 'log', '--format=%H', '-2', '--reverse').trim().split('\n');
    const patch = path.join(source, '..', 'two.patch');
    writeFileSync(patch, await (await Repository.open(source))!.formatPatch(hashes));

    const commits = init('patch-commits');
    git(commits, 'fetch', '-q', source, base);
    git(commits, 'reset', '-q', '--hard', base);
    await (await Repository.open(commits))!.applyPatch(patch, true);
    expect(git(commits, 'log', '--format=%s', '-3').trim().split('\n')).toEqual(['change a', 'add b', 'a']);

    const changes = init('patch-changes');
    git(changes, 'fetch', '-q', source, base);
    git(changes, 'reset', '-q', '--hard', base);
    await (await Repository.open(changes))!.applyPatch(patch, false);
    expect(git(changes, 'log', '--format=%s').trim()).toBe('a');
    expect(readFileSync(path.join(changes, 'a.txt'), 'utf8')).toBe('a2\n');
    expect(readFileSync(path.join(changes, 'b.txt'), 'utf8')).toBe('b\n');
  });

  it('cherry-picks several commits in the given order', async () => {
    const dir = init('pick-many');
    commitFile(dir, 'a.txt', 'a\n', 'a');
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitFile(dir, 'b.txt', 'b\n', 'b');
    commitFile(dir, 'c.txt', 'c\n', 'c');
    const [c, b] = git(dir, 'log', '--format=%H', '-2').trim().split('\n');
    git(dir, 'checkout', '-q', 'main');
    const repository = (await Repository.open(dir))!;

    expect(await repository.cherryPick(b, c)).toBe('done');
    expect(git(dir, 'log', '--format=%s').trim().split('\n')).toEqual(['c', 'b', 'a']);
  });

  it('reports uncommitted changes that come back from the autostash with conflicts', async () => {
    const dir = init('autostash');
    commitFile(dir, 'a.txt', 'a\n', 'a');
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitFile(dir, 'a.txt', 'feature\n', 'feature a');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(path.join(dir, 'a.txt'), 'local\n');
    const repository = (await Repository.open(dir))!;

    expect(await repository.merge('feature')).toBe('stash-conflicts');
    expect(await repository.operation()).toBeUndefined();
    expect((await repository.conflicts()).map((f) => f.path)).toEqual(['a.txt']);

    writeFileSync(path.join(dir, 'a.txt'), 'resolved\n');
    await repository.markResolved(['a.txt']);
    expect(await repository.conflicts()).toEqual([]);
    expect(git(dir, 'status', '--porcelain')).toBe(' M a.txt\n');
    expect(await repository.dropAutostash()).toBe(true);
    expect(git(dir, 'stash', 'list')).toBe('');
  });

  it('moves a branch only from the commit it was seen at, and lists commits not pushed yet', async () => {
    const dir = init('move');
    commitFile(dir, 'a.txt', 'a\n', 'a');
    const first = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'branch', 'other');
    commitFile(dir, 'a.txt', 'a2\n', 'a2');
    const second = git(dir, 'rev-parse', 'HEAD').trim();
    const repository = (await Repository.open(dir))!;

    await expect(repository.moveBranch('other', second, second)).rejects.toThrow();
    await repository.moveBranch('other', second, first);
    expect(git(dir, 'rev-parse', 'other').trim()).toBe(second);

    expect((await repository.outgoing('main', undefined)).map((c) => c.subject)).toEqual(['a2', 'a']);
    expect((await repository.outgoing('main', first)).map((c) => c.subject)).toEqual(['a2']);
  });

  it('offers what to push and force-pushes only over the remote branch it has seen', async () => {
    const server = path.join(work, 'push-server.git');
    git(work, 'init', '-q', '--bare', '-b', 'main', server);
    const dir = init('push');
    commitFile(dir, 'a.txt', 'a\n', 'a');
    git(dir, 'remote', 'add', 'origin', server);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitFile(dir, 'f.txt', 'f\n', 'f');
    const repository = (await Repository.open(dir))!;
    const notProtected = () => false;

    let state = await readPushState(repository, undefined, notProtected);
    expect(state.branches).toMatchObject([
      { branch: 'feature', remote: 'origin', target: 'feature', hasUpstream: false, existsOnRemote: false },
    ]);
    expect(state.branches[0].commits.map((c) => c.subject)).toEqual(['f']);
    await repository.git.run(pushArgs({ ...state.branches[0], force: false }, true, undefined));
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'feature@{u}').trim()).toBe('origin/feature');

    // The branch is rebased locally while somebody else pushes to it.
    const other = path.join(work, 'push-other');
    git(work, 'clone', '-q', '-b', 'feature', server, other);
    git(other, 'config', 'user.name', 'O');
    git(other, 'config', 'user.email', 'o@x');
    git(dir, 'commit', '-q', '--amend', '-m', 'f amended');
    git(dir, 'fetch', '-q');
    state = await readPushState(repository, 'feature', notProtected);
    expect(state.branches[0]).toMatchObject({ hasUpstream: true, existsOnRemote: true, behind: 1 });
    commitFile(other, 'o.txt', 'o\n', 'other');
    git(other, 'push', '-q');

    const request = { ...state.branches[0], force: true };
    const lease = state.leases.get('origin/feature');
    await expect(repository.git.run(pushArgs({ ...request, force: false }, false, lease))).rejects.toThrow();
    await expect(repository.git.run(pushArgs(request, false, lease))).rejects.toThrow(/stale info/);

    git(dir, 'fetch', '-q');
    state = await readPushState(repository, 'feature', notProtected);
    await repository.git.run(pushArgs(request, false, state.leases.get('origin/feature')));
    expect(git(server, 'log', '-1', '--format=%s', 'feature').trim()).toBe('f amended');
  });

  it('pushes a branch to another remote than its upstream, which stays', async () => {
    const origin = path.join(work, 'two-origin.git');
    const mirror = path.join(work, 'two-mirror.git');
    git(work, 'init', '-q', '--bare', '-b', 'main', origin);
    git(work, 'init', '-q', '--bare', '-b', 'main', mirror);
    const dir = init('two-remotes');
    commitFile(dir, 'a.txt', 'a\n', 'a');
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'remote', 'add', 'github', mirror);
    git(dir, 'push', '-q', 'github', 'main');
    commitFile(dir, 'b.txt', 'b\n', 'b');
    commitFile(dir, 'c.txt', 'c\n', 'c');
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    git(dir, 'fetch', '-q', 'github');
    const repository = (await Repository.open(dir))!;
    const notProtected = () => false;

    const state = await readPushState(repository, 'main', notProtected);
    expect(state.branches[0]).toMatchObject({ remote: 'origin', target: 'main', upstream: 'origin/main' });
    expect(state.branches[0].commits).toEqual([]);

    const other = (await retarget(repository, 'main', 'github', 'main', notProtected, 'main'))!;
    expect(other.view).toMatchObject({
      remote: 'github',
      existsOnRemote: true,
      behind: 0,
      upstream: 'origin/main',
    });
    expect(other.view.commits.map((c) => c.subject)).toEqual(['c', 'b']);
    await repository.git.run(pushArgs({ ...other.view, force: false }, !other.view.hasUpstream, other.lease));
    expect(git(mirror, 'log', '-1', '--format=%s', 'main').trim()).toBe('c');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'main@{u}').trim()).toBe('origin/main');
  });

  it('checks the lower branches of the stack along with the current one', async () => {
    const server = path.join(work, 'stack-server.git');
    git(work, 'init', '-q', '--bare', '-b', 'main', server);
    const dir = init('stack-push');
    commitFile(dir, 'a.txt', 'a\n', 'a');
    git(dir, 'remote', 'add', 'origin', server);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    git(dir, 'checkout', '-q', '-b', 'lower');
    commitFile(dir, 'l.txt', 'l\n', 'l');
    git(dir, 'push', '-q', '-u', 'origin', 'lower');
    git(dir, 'checkout', '-q', '-b', 'upper');
    commitFile(dir, 'u.txt', 'u\n', 'u');
    git(dir, 'push', '-q', '-u', 'origin', 'upper');
    git(dir, 'checkout', '-q', '-b', 'aside', 'main');
    commitFile(dir, 's.txt', 's\n', 's');
    git(dir, 'push', '-q', '-u', 'origin', 'aside');
    commitFile(dir, 's2.txt', 's\n', 's2');
    git(dir, 'checkout', '-q', 'main');
    commitFile(dir, 'm.txt', 'm\n', 'm');
    git(dir, 'checkout', '-q', 'upper');
    const repository = (await Repository.open(dir))!;
    expect(await repository.rebase('main', undefined, { updateRefs: true })).toBe('done');

    const state = await readPushState(repository, undefined, () => false);
    const checked = Object.fromEntries(state.branches.map((b) => [b.branch, b.checked]));
    expect(checked).toEqual({ upper: true, lower: true, main: false, aside: false });
  });

  it('matches protected branches by name or pattern', () => {
    expect(matchesBranchPattern(['master', 'release/*'], 'master')).toBe(true);
    expect(matchesBranchPattern(['master', 'release/*'], 'release/1.2')).toBe(true);
    expect(matchesBranchPattern(['master', 'release/*'], 'master-fix')).toBe(false);
  });
});
