import { describe, expect, it } from 'vitest';
import {
  parseHunks,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStashes,
  parseWorktrees,
} from '../src/extension/git/parse';

const F = '\x1f';
const R = '\x1e';

describe('parseLog', () => {
  it('reads commits with zero, one and two parents', () => {
    const output =
      `aaa${F}${F}Ann${F}ann@x${F}100${F}root${R}\n` +
      `bbb${F}aaa${F}Bob${F}bob@x${F}200${F}fix: a${F}b${R}\n` +
      `ccc${F}bbb ddd${F}Ann${F}ann@x${F}300${F}Merge${R}\n`;

    const commits = parseLog(output);

    expect(commits).toHaveLength(3);
    expect(commits[0]).toEqual({
      hash: 'aaa',
      parents: [],
      authorName: 'Ann',
      authorEmail: 'ann@x',
      authorDate: 100,
      subject: 'root',
    });
    expect(commits[2].parents).toEqual(['bbb', 'ddd']);
  });
});

describe('parseRefs', () => {
  it('classifies refs, peels tags and reads upstream tracking', () => {
    const output = [
      `refs/heads/main${F}111${F}${F}refs/remotes/origin/main${F}ahead 2, behind 3`,
      `refs/heads/gone${F}222${F}${F}refs/remotes/origin/gone${F}gone`,
      `refs/heads/local${F}333${F}${F}${F}`,
      `refs/remotes/origin/HEAD${F}111${F}${F}${F}`,
      `refs/remotes/origin/main${F}444${F}${F}${F}`,
      `refs/tags/v1${F}tagobj${F}555${F}${F}`,
      `refs/stash${F}666${F}${F}${F}`,
    ].join('\n');

    const refs = parseRefs(output);

    expect(refs.map((r) => [r.kind, r.name, r.hash])).toEqual([
      ['head', 'main', '111'],
      ['head', 'gone', '222'],
      ['head', 'local', '333'],
      ['remote', 'origin/main', '444'],
      ['tag', 'v1', '555'],
    ]);
    expect(refs[0]).toMatchObject({ upstream: 'refs/remotes/origin/main', ahead: 2, behind: 3 });
    expect(refs[1]).toMatchObject({ upstreamGone: true });
    expect(refs[2].upstream).toBeUndefined();
  });
});

describe('parseWorktrees', () => {
  it('reads main and linked worktrees and marks the current one', () => {
    const output = [
      'worktree /repo',
      'HEAD 111',
      'branch refs/heads/main',
      '',
      'worktree /repo-feature',
      'HEAD 222',
      'detached',
      'locked reason',
      '',
      'worktree /gone',
      'HEAD 333',
      'branch refs/heads/old',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    const worktrees = parseWorktrees(output, '/repo-feature/');

    expect(worktrees).toEqual([
      {
        path: '/repo',
        head: '111',
        branch: 'main',
        isMain: true,
        isCurrent: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo-feature',
        head: '222',
        branch: undefined,
        isMain: false,
        isCurrent: true,
        locked: true,
        prunable: false,
      },
      {
        path: '/gone',
        head: '333',
        branch: 'old',
        isMain: false,
        isCurrent: false,
        locked: false,
        prunable: true,
      },
    ]);
  });
});

describe('parseStashes', () => {
  it('reads stash entries', () => {
    const output = `sss${F}aaa bbb${F}stash@{0}${F}100${F}WIP on main: x${R}\n`;

    expect(parseStashes(output)).toEqual([
      { hash: 'sss', parents: ['aaa', 'bbb'], selector: 'stash@{0}', date: 100, message: 'WIP on main: x' },
    ]);
  });
});

describe('parseNameStatus', () => {
  it('reads plain changes, renames and copies', () => {
    const output = [
      'M',
      'src/a.ts',
      'R087',
      'old/b.ts',
      'new/b.ts',
      'A',
      'c d.ts',
      'C100',
      'x',
      'y',
      'D',
      'z',
      '',
    ].join('\0');

    expect(parseNameStatus(output)).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', path: 'new/b.ts', oldPath: 'old/b.ts' },
      { status: 'A', path: 'c d.ts' },
      { status: 'C', path: 'y', oldPath: 'x' },
      { status: 'D', path: 'z' },
    ]);
  });
});

describe('parseHunks', () => {
  it('reads hunk headers with and without line counts', () => {
    const output = [
      'diff --git a/x b/x',
      '@@ -3 +3 @@ ctx',
      '-a',
      '+b',
      '@@ -10,0 +11,2 @@',
      '+c',
      '+d',
      '@@ -20,3 +22,0 @@',
    ].join('\n');

    expect(parseHunks(output)).toEqual([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
      { oldStart: 10, oldLines: 0, newStart: 11, newLines: 2 },
      { oldStart: 20, oldLines: 3, newStart: 22, newLines: 0 },
    ]);
  });
});
