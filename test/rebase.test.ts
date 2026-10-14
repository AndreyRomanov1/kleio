import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRebaseTodo } from '../src/extension/git/rebasePlan';
import { Repository } from '../src/extension/git/repository';

let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A repository with `base` and then commits one…four, each adding its own file. */
function repo(name: string): { dir: string; hashes: Record<string, string> } {
  const dir = path.join(work, name);
  git(work, 'init', '-q', '-b', 'main', dir);
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'user.email', 't@x');
  const hashes: Record<string, string> = {};
  for (const name of ['base', 'one', 'two', 'three', 'four']) {
    writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `${name}\n\nbody of ${name}`);
    hashes[name] = git(dir, 'rev-parse', 'HEAD').trim();
  }
  return { dir, hashes };
}

const subjects = (dir: string) => git(dir, 'log', '--format=%s', 'main').trim().split('\n');

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'grove-rebase-'));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('interactive rebase', () => {
  it('builds a todo list that needs no editor', () => {
    const originals = new Map([
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
      ['d', 'D'],
    ]);
    const { todo, messages } = buildRebaseTodo(
      [
        { hash: 'a', action: 'pick', message: 'A' },
        { hash: 'b', action: 'reword', message: 'B new' },
        { hash: 'c', action: 'squash' },
        { hash: 'd', action: 'drop' },
      ],
      originals,
      (name) => `/git dir/${name}`,
    );
    expect(todo.split('\n')).toEqual([
      'pick a',
      'pick b',
      'fixup c',
      'drop d',
      "exec git commit --amend --allow-empty --no-verify --quiet --cleanup=strip -F '/git dir/message-1.txt'",
      '',
    ]);
    expect([...messages]).toEqual([['message-1.txt', 'B new']]);
    expect(() => buildRebaseTodo([{ hash: 'a', action: 'fixup' }], originals, (n) => n)).toThrow();
  });

  it('rewords, squashes with a combined message, drops and reorders commits', async () => {
    const { dir, hashes } = repo('plan');
    const repository = (await Repository.open(dir))!;

    const outcome = await repository.interactiveRebase(hashes.base, [
      { hash: hashes.three, action: 'reword', message: 'three first\n\nnew body' },
      { hash: hashes.one, action: 'pick', message: 'one\n\nbody of one' },
      { hash: hashes.four, action: 'squash' },
      { hash: hashes.two, action: 'drop' },
    ]);

    expect(outcome).toBe('done');
    expect(subjects(dir)).toEqual(['one', 'three first', 'base']);
    expect(git(dir, 'log', '-1', '--format=%B', 'main~1').trim()).toBe('three first\n\nnew body');
    expect(git(dir, 'show', '--name-only', '--format=', 'main').trim().split('\n')).toEqual([
      'four.txt',
      'one.txt',
    ]);
    expect(await repository.operation()).toBeUndefined();
  });

  it('squashes into a commit with the message chosen in the dialog, even if it is the original one', async () => {
    const { dir, hashes } = repo('squash');
    const repository = (await Repository.open(dir))!;

    await repository.interactiveRebase(hashes.two, [
      { hash: hashes.three, action: 'pick', message: 'three\n\nbody of three\n\nfour' },
      { hash: hashes.four, action: 'squash' },
    ]);
    expect(subjects(dir)).toEqual(['three', 'two', 'one', 'base']);
    expect(git(dir, 'log', '-1', '--format=%B').trim()).toBe('three\n\nbody of three\n\nfour');
  });

  it('stops at an edit and goes on with the remaining commits', async () => {
    const { dir, hashes } = repo('edit');
    const repository = (await Repository.open(dir))!;

    const outcome = await repository.interactiveRebase(hashes.two, [
      { hash: hashes.three, action: 'edit', message: 'three\n\nbody of three' },
      { hash: hashes.four, action: 'pick', message: 'four\n\nbody of four' },
    ]);
    expect(outcome).toBe('stopped');
    expect(await repository.operation()).toMatchObject({ kind: 'rebase', branch: 'main', conflicted: [] });

    writeFileSync(path.join(dir, 'three.txt'), 'three edited\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '--amend', '--no-edit');
    expect(await repository.continueOperation('rebase')).toBe('done');
    expect(subjects(dir)).toEqual(['four', 'three', 'two', 'one', 'base']);
    expect(git(dir, 'show', 'main~1:three.txt')).toBe('three edited\n');
  });

  it('lists the commits to rebase and how many of them are published', async () => {
    const { dir, hashes } = repo('range');
    const repository = (await Repository.open(dir))!;
    const range = await repository.rebaseRange(hashes.two);
    expect(range.commits.map((c) => c.message.split('\n')[0])).toEqual(['three', 'four']);
    expect(range.merges).toBe(0);
    expect(await repository.isAncestor(hashes.one, 'HEAD')).toBe(true);
    expect(await repository.isAncestor('HEAD', hashes.one)).toBe(false);
    expect(await repository.publishedCount(hashes.two)).toBe(0);
    expect((await repository.rebaseRange(undefined)).commits).toHaveLength(5);
  });
});
