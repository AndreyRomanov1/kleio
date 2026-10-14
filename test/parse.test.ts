import { describe, expect, it } from 'vitest';
import {
  parseBlame,
  parseHistory,
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

describe('parseBlame', () => {
  it('reads porcelain output where commit details appear once per commit', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const output = [
      `${a} 1 1 2`,
      'author Ann',
      'author-mail <ann@x>',
      'author-time 100',
      'summary first',
      'filename old.ts',
      '\tline one',
      `${a} 2 2`,
      '\tline two',
      `${b} 5 3 1`,
      'author Bob',
      'author-mail <bob@x>',
      'author-time 200',
      'summary second',
      `previous ${a} old name.ts`,
      'filename new.ts',
      '\tline three',
      '',
    ].join('\n');

    const lines = parseBlame(output);

    expect(lines.map((l) => [l.line, l.originalLine, l.commit.hash[0]])).toEqual([
      [1, 1, 'a'],
      [2, 2, 'a'],
      [3, 5, 'b'],
    ]);
    expect(lines[0].commit).toMatchObject({
      author: 'Ann',
      authorMail: 'ann@x',
      authorTime: 100,
      filename: 'old.ts',
    });
    expect(lines[0].commit).toBe(lines[1].commit);
    expect(lines[2].commit.previous).toEqual({ hash: a, filename: 'old name.ts' });
  });
});

describe('parseHistory', () => {
  it('reads commits with the file path from name-status or patch bodies', () => {
    const output =
      `\x1eaaa${F}p1${F}Ann${F}a@x${F}100${F}rename${F}\n\nR100\told/x.ts\tnew/x.ts\n` +
      `\x1ebbb${F}${F}Bob${F}b@x${F}50${F}add${F}\n\nA\told/x.ts\n` +
      `\x1eccc${F}ddd${F}Ann${F}a@x${F}20${F}patch${F}\n\ndiff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n` +
      `\x1eeee${F}fff${F}Ann${F}a@x${F}10${F}deleted${F}\n\ndiff --git a/z.ts b/z.ts\n--- a/z.ts\n+++ /dev/null\n`;

    const history = parseHistory(output);

    expect(history.commits.map((c) => [c.hash, c.subject, c.parents])).toEqual([
      ['aaa', 'rename', ['p1']],
      ['bbb', 'add', []],
      ['ccc', 'patch', ['ddd']],
      ['eee', 'deleted', ['fff']],
    ]);
    expect(history.paths).toEqual({ aaa: 'new/x.ts', bbb: 'old/x.ts', ccc: 'y.ts', eee: 'z.ts' });
  });
});
