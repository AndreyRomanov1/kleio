import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { FileChange } from '../../shared/model';
import { t } from '../../shared/l10n';
import type { ChangeSet } from './changeSet';

/** The version of the guide format Kleio reads. */
export const GUIDE_VERSION = 1;

export interface GuideCategory {
  id: string;
  title: string;
  description?: string;
  /** 1–10: how much the files of the category need a look. */
  importance: number;
}

export interface GuideFile {
  path: string;
  category: string;
  /** 1–10; the importance of the category when left out. */
  importance?: number;
  note?: string;
}

/**
 * How someone, an agent as a rule, sorted the files of a diff for review. It lies outside the working tree, in
 * `<git common dir>/kleio/guides/<branch>.json`, so every worktree of the repository sees it.
 */
export interface ReviewGuide {
  version: number;
  base?: string;
  /** The revision the guide was made for. */
  head: string;
  summary?: string;
  categories: GuideCategory[];
  files: GuideFile[];
}

/** Where a file of the set stands in the guide. */
export interface GuidePlace {
  category: GuideCategory;
  importance: number;
  note?: string;
}

/** The category of files the guide does not mention. */
export const UNSORTED = '';

/** Reads a guide; a string is what is wrong with it. */
export function parseGuide(text: string): ReviewGuide | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return t('not JSON: {0}', e instanceof Error ? e.message : String(e));
  }
  if (!isObject(raw)) return t('not a JSON object');
  if (raw.version !== GUIDE_VERSION) return t('format version {0} is expected', GUIDE_VERSION);
  if (typeof raw.head !== 'string' || !raw.head) return t('"head" is missing');
  if (!Array.isArray(raw.categories)) return t('"categories" is not a list');
  if (!Array.isArray(raw.files)) return t('"files" is not a list');
  const categories: GuideCategory[] = [];
  for (const c of raw.categories) {
    if (!isObject(c) || typeof c.id !== 'string' || !c.id) return t('a category without "id"');
    categories.push({
      id: c.id,
      title: typeof c.title === 'string' && c.title ? c.title : c.id,
      description: typeof c.description === 'string' ? c.description : undefined,
      importance: importanceOf(c.importance) ?? 5,
    });
  }
  const files: GuideFile[] = [];
  for (const f of raw.files) {
    if (!isObject(f) || typeof f.path !== 'string' || typeof f.category !== 'string')
      return t('a file without "path" or "category"');
    files.push({
      path: f.path,
      category: f.category,
      importance: importanceOf(f.importance),
      note: typeof f.note === 'string' && f.note ? f.note : undefined,
    });
  }
  return {
    version: GUIDE_VERSION,
    base: typeof raw.base === 'string' ? raw.base : undefined,
    head: raw.head,
    summary: typeof raw.summary === 'string' && raw.summary ? raw.summary : undefined,
    categories,
    files,
  };
}

/**
 * The place of every file of the set, by index. A file the guide does not mention is unsorted; a category the
 * guide does not describe is taken by its id.
 */
export function placeFiles(guide: ReviewGuide, files: readonly FileChange[]): GuidePlace[] {
  const categories = new Map(guide.categories.map((c) => [c.id, c]));
  const byPath = new Map(guide.files.map((f) => [f.path, f]));
  const unsorted: GuideCategory = { id: UNSORTED, title: t('No category'), importance: 0 };
  return files.map((file) => {
    const entry = byPath.get(file.path) ?? (file.oldPath ? byPath.get(file.oldPath) : undefined);
    if (!entry) return { category: unsorted, importance: 0 };
    let category = categories.get(entry.category);
    if (!category) {
      category = { id: entry.category, title: entry.category, importance: entry.importance ?? 5 };
      categories.set(category.id, category);
    }
    return { category, importance: entry.importance ?? category.importance, note: entry.note };
  });
}

/**
 * The categories in the order to look at them: the more important first, as the guide lists them when equal;
 * unsorted files last.
 */
export function categoryOrder(places: readonly GuidePlace[]): GuideCategory[] {
  const seen = new Map<string, { category: GuideCategory; first: number }>();
  places.forEach((p, index) => {
    if (!seen.has(p.category.id)) seen.set(p.category.id, { category: p.category, first: index });
  });
  return [...seen.values()]
    .sort(
      (a, b) =>
        Number(a.category.id === UNSORTED) - Number(b.category.id === UNSORTED) ||
        b.category.importance - a.category.importance ||
        a.first - b.first,
    )
    .map((s) => s.category);
}

/** Indexes of the files grouped by category in {@link categoryOrder}, the more important first in a group. */
export function guideOrder(places: readonly GuidePlace[], hidden: ReadonlySet<string> = new Set()): number[] {
  const rank = new Map(categoryOrder(places).map((c, i) => [c.id, i]));
  return places
    .map((place, index) => ({ place, index }))
    .filter((p) => !hidden.has(p.place.category.id))
    .sort(
      (a, b) =>
        rank.get(a.place.category.id)! - rank.get(b.place.category.id)! ||
        b.place.importance - a.place.importance ||
        a.index - b.index,
    )
    .map((p) => p.index);
}

/** Whether a guide was made for this revision; an abbreviated hash in the guide counts. */
export function madeFor(guide: ReviewGuide, revision: string): boolean {
  return guide.head === revision || (guide.head.length >= 7 && revision.startsWith(guide.head));
}

/** The guide of a change set, or why the one of its branch cannot be read. */
export type FoundGuide =
  | { guide: ReviewGuide; file: string; places: GuidePlace[]; stale: boolean }
  | { file: string; error: string };

/**
 * The guides of a repository, read again whenever a file changes: an agent may rewrite one while the diff is open.
 */
export class ReviewGuides {
  private readonly read = new Map<string, { mtime: number; guide: ReviewGuide | string }>();

  static folder(commonDir: string): string {
    return path.join(commonDir, 'kleio', 'guides');
  }

  /**
   * The guide made for the newer side of the set, the latest when several are. Failing that, the guide of the
   * set's branch, stale as it is made for another revision.
   */
  async find(changeSet: ChangeSet): Promise<FoundGuide | undefined> {
    const folder = ReviewGuides.folder(changeSet.repository.commonDir);
    const names = await readdir(folder, { recursive: true }).catch(() => [] as string[]);
    const guides = await Promise.all(
      names
        .filter((n) => n.endsWith('.json'))
        .map(async (name) => {
          const file = path.join(folder, name);
          const mtime = await stat(file).then(
            (s) => s.mtimeMs,
            () => undefined,
          );
          return mtime === undefined ? undefined : { file, mtime, guide: await this.parse(file, mtime) };
        }),
    );
    const found = guides
      .filter((g) => g !== undefined)
      .sort((a, b) => b.mtime - a.mtime)
      .find((g) => typeof g.guide !== 'string' && madeFor(g.guide, changeSet.right));
    const branchFile = changeSet.branch && path.join(folder, `${changeSet.branch}.json`);
    const chosen = found ?? guides.find((g) => g?.file === branchFile);
    if (!chosen) return undefined;
    if (typeof chosen.guide === 'string') return { file: chosen.file, error: chosen.guide };
    return {
      guide: chosen.guide,
      file: chosen.file,
      places: placeFiles(chosen.guide, changeSet.files),
      stale: !found,
    };
  }

  private async parse(file: string, mtime: number): Promise<ReviewGuide | string> {
    const known = this.read.get(file);
    if (known?.mtime === mtime) return known.guide;
    const guide = await readFile(file, 'utf8').then(parseGuide, (e: Error) => e.message);
    this.read.set(file, { mtime, guide });
    return guide;
  }
}

function importanceOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(10, Math.max(1, Math.round(value)))
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
