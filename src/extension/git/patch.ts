import { createHash } from 'node:crypto';
import type { HunkView } from '../../shared/commitProtocol';

export interface PatchHunk {
  /** Content-based identity that survives line shifts elsewhere in the file. */
  key: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The `@@` line and the lines after it, as in the patch. */
  text: string[];
}

export interface FilePatch {
  /** Lines before the first hunk: `diff --git`, `index`, `---`, `+++`. */
  header: string[];
  hunks: PatchHunk[];
}

/** Longer hunks are chosen whole: a list of thousands of lines helps nobody. */
const MAX_SELECTABLE_LINES = 500;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Splits the diff of one file into its header and hunks; binary diffs have no hunks. */
export function parseFilePatch(output: string): FilePatch {
  const lines = output.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const header: string[] = [];
  const hunks: PatchHunk[] = [];
  const seen = new Map<string, number>();
  let current: Omit<PatchHunk, 'key'> | undefined;
  const finish = () => {
    if (!current) return;
    const digest = createHash('sha1').update(current.text.slice(1).join('\n')).digest('hex').slice(0, 16);
    const count = seen.get(digest) ?? 0;
    seen.set(digest, count + 1);
    hunks.push({ ...current, key: count ? `${digest}#${count}` : digest });
  };
  for (const line of lines) {
    const match = HUNK_HEADER.exec(line);
    if (match) {
      finish();
      current = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        text: [line],
      };
    } else if (current) {
      current.text.push(line);
    } else {
      header.push(line);
    }
  }
  finish();
  return { header, hunks };
}

/** A selection made by {@link hunkSelection}. */
function parseSelection(selection: string): { key: string; lines?: Set<number> } {
  const at = selection.indexOf('@');
  if (at < 0) return { key: selection };
  return {
    key: selection.slice(0, at),
    lines: new Set(
      selection
        .slice(at + 1)
        .split(',')
        .map(Number),
    ),
  };
}

/** Whether every chosen hunk is still in the patch: the file may have changed since the list was shown. */
export function hasHunks(patch: FilePatch, selections: readonly string[]): boolean {
  const known = new Set(patch.hunks.map((h) => h.key));
  return selections.every((s) => known.has(parseSelection(s).key));
}

/**
 * A patch of the file with only the chosen hunks and lines, for `git apply --unidiff-zero`. See
 * {@link partialHunk} for the lines left out.
 */
export function selectHunks(patch: FilePatch, selections: Iterable<string>, reverse = false): string {
  const chosen = new Map<string, Set<number> | undefined>();
  for (const selection of selections) {
    const { key, lines } = parseSelection(selection);
    chosen.set(key, lines);
  }
  const hunks: string[][] = [];
  for (const hunk of patch.hunks) {
    if (!chosen.has(hunk.key)) continue;
    const lines = chosen.get(hunk.key);
    const text = lines ? partialHunk(hunk, lines, reverse) : hunk.text;
    if (text) hunks.push(text);
  }
  return [...patch.header, ...hunks.flat()].join('\n') + '\n';
}

/**
 * A hunk without context (its removed lines, then its added ones) with only some of its lines. The n-th
 * removed line and the n-th added one are taken as a line and what it became, so that a changed line taken
 * alone lands where the old one was: of `-b -c +B +C`, `-b +B` gives `B c`, not `c B`.
 *
 * A line left out stays as it is in the file the patch goes to: a removed one is context when the patch is
 * applied forward, an added one when it is applied in reverse (`-R`, rolling back or unstaging); the other
 * kind is dropped.
 */
function partialHunk(hunk: PatchHunk, lines: ReadonlySet<number>, reverse: boolean): string[] | undefined {
  const removed: { line: string; index: number }[] = [];
  const added: { line: string; index: number }[] = [];
  hunk.text.slice(1).forEach((line, index) => {
    if (line.startsWith('-')) removed.push({ line, index });
    else if (line.startsWith('+')) added.push({ line, index });
  });
  const body: string[] = [];
  let changes = 0;
  const take = (entry: { line: string; index: number } | undefined, keptAsContext: boolean) => {
    if (!entry) return;
    if (lines.has(entry.index)) {
      body.push(entry.line);
      changes++;
    } else if (keptAsContext) {
      body.push(' ' + entry.line.slice(1));
    }
  };
  for (let i = 0; i < Math.max(removed.length, added.length); i++) {
    take(removed[i], !reverse);
    take(added[i], reverse);
  }
  if (!changes) return undefined;
  const count = (sign: string) => body.filter((l) => l[0] === sign || l[0] === ' ').length;
  // A side with no lines names the line before the change, a side with lines its first line.
  const start = (from: number, before: number, after: number) =>
    before === 0 && after > 0 ? from + 1 : before > 0 && after === 0 ? from - 1 : from;
  const oldLines = count('-');
  const newLines = count('+');
  return [
    `@@ -${start(hunk.oldStart, hunk.oldLines, oldLines)},${oldLines} +${start(hunk.newStart, hunk.newLines, newLines)},${newLines} @@`,
    ...body,
  ];
}

/** What the commit view shows of each hunk: where it starts in the working file and its first changed lines. */
export function hunkViews(patch: FilePatch): HunkView[] {
  return patch.hunks.map((hunk) => {
    const body = hunk.text.slice(1);
    const changed = body.filter((l) => l.startsWith('+') || l.startsWith('-'));
    const firstChange = body.findIndex((l) => l.startsWith('+') || l.startsWith('-'));
    const before = body.slice(0, Math.max(0, firstChange)).filter((l) => !l.startsWith('-')).length;
    return {
      key: hunk.key,
      line: hunk.newStart + before,
      added: body.filter((l) => l.startsWith('+')).length,
      removed: body.filter((l) => l.startsWith('-')).length,
      preview: changed.filter((l) => l.slice(1).trim()).slice(0, 3),
      lines:
        changed.length <= MAX_SELECTABLE_LINES
          ? body.flatMap((text, index) =>
              text.startsWith('+') || text.startsWith('-') ? [{ index, text }] : [],
            )
          : undefined,
    };
  });
}
