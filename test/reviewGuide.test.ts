import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangeSet } from '../src/extension/changes/changeSet';
import {
  categoryOrder,
  guideOrder,
  parseGuide,
  placeFiles,
  ReviewGuides,
  type ReviewGuide,
} from '../src/extension/changes/reviewGuide';
import type { FileChange } from '../src/shared/model';

const guide = (over: Partial<ReviewGuide> = {}): ReviewGuide => ({
  version: 1,
  head: 'abcdef1234',
  categories: [
    { id: 'usings', title: 'Usings', importance: 1 },
    { id: 'logic', title: 'Logic', importance: 9 },
    { id: 'di', title: 'DI', importance: 4 },
  ],
  files: [
    { path: 'a.cs', category: 'usings' },
    { path: 'b.cs', category: 'logic', importance: 6 },
    { path: 'c.cs', category: 'logic', importance: 10, note: 'the core' },
    { path: 'd.cs', category: 'di' },
    { path: 'e.cs', category: 'tests', importance: 3 },
  ],
  ...over,
});

const files = (...paths: string[]): FileChange[] => paths.map((p) => ({ path: p, status: 'M' }));

describe('parseGuide', () => {
  it('reads a guide and fills what is left out', () => {
    const parsed = parseGuide(
      JSON.stringify({
        version: 1,
        head: 'abc1234',
        categories: [{ id: 'logic', importance: 12.4 }],
        files: [{ path: 'a.cs', category: 'logic', note: '' }],
      }),
    );
    expect(parsed).toEqual({
      version: 1,
      head: 'abc1234',
      base: undefined,
      summary: undefined,
      categories: [{ id: 'logic', title: 'logic', description: undefined, importance: 10 }],
      files: [{ path: 'a.cs', category: 'logic', importance: undefined, note: undefined }],
    });
  });

  it('says what is wrong', () => {
    expect(parseGuide('{')).toMatch(/^not JSON/);
    expect(parseGuide('{"version":2,"head":"a","categories":[],"files":[]}')).toBe(
      'format version 1 is expected',
    );
    expect(parseGuide('{"version":1,"categories":[],"files":[]}')).toBe('"head" is missing');
    expect(parseGuide('{"version":1,"head":"a","categories":[],"files":[{"path":"a"}]}')).toBe(
      'a file without "path" or "category"',
    );
  });
});

describe('order', () => {
  it('groups files by the importance of their category, unsorted last', () => {
    const places = placeFiles(guide(), files('x.cs', 'a.cs', 'b.cs', 'c.cs', 'd.cs', 'e.cs'));
    expect(categoryOrder(places).map((c) => c.id)).toEqual(['logic', 'di', 'tests', 'usings', '']);
    expect(guideOrder(places)).toEqual([3, 2, 4, 5, 1, 0]);
    expect(places[3].note).toBe('the core');
    expect(places[4].importance).toBe(4);
  });

  it('leaves out hidden categories', () => {
    const places = placeFiles(guide(), files('a.cs', 'b.cs', 'd.cs'));
    expect(guideOrder(places, new Set(['usings', 'di']))).toEqual([1]);
  });

  it('finds a moved file by its old path', () => {
    const places = placeFiles(guide(), [{ path: 'new/b.cs', oldPath: 'b.cs', status: 'R' }]);
    expect(places[0].category.id).toBe('logic');
  });
});

describe('ReviewGuides', () => {
  async function repository(): Promise<{ commonDir: string; folder: string }> {
    const commonDir = await mkdtemp(path.join(tmpdir(), 'kleio-guide-'));
    const folder = ReviewGuides.folder(commonDir);
    await mkdir(path.join(folder, 'feature'), { recursive: true });
    return { commonDir, folder };
  }

  const set = (commonDir: string, right: string, branch?: string): ChangeSet =>
    ({
      repository: { commonDir },
      title: '',
      left: 'base',
      right,
      branch,
      files: files('b.cs'),
    }) as ChangeSet;

  it('takes the guide made for the revision, or else the stale one of the branch', async () => {
    const { commonDir, folder } = await repository();
    await writeFile(path.join(folder, 'feature', 'x.json'), JSON.stringify(guide()));
    await writeFile(path.join(folder, 'other.json'), JSON.stringify(guide({ head: 'fff0000' })));
    const guides = new ReviewGuides();

    const fresh = await guides.find(set(commonDir, 'abcdef1234567890'));
    expect(fresh && 'places' in fresh && [fresh.stale, fresh.places[0].category.id]).toEqual([
      false,
      'logic',
    ]);

    const stale = await guides.find(set(commonDir, '1111111', 'feature/x'));
    expect(stale && 'guide' in stale && [stale.stale, stale.guide.head]).toEqual([true, 'abcdef1234']);

    expect(await guides.find(set(commonDir, '1111111', 'feature/y'))).toBeUndefined();
  });

  it('reads a rewritten guide again and reports a broken one', async () => {
    const { commonDir, folder } = await repository();
    const file = path.join(folder, 'main.json');
    await writeFile(file, '{');
    const guides = new ReviewGuides();
    expect(await guides.find(set(commonDir, 'abcdef1234', 'main'))).toMatchObject({
      error: expect.any(String),
    });
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(file, JSON.stringify(guide()));
    expect(await guides.find(set(commonDir, 'abcdef1234', 'main'))).toMatchObject({ stale: false });
  });
});
