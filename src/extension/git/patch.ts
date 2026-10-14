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

/** A patch of the file with only the chosen hunks, for `git apply --recount`. */
export function selectHunks(patch: FilePatch, keys: ReadonlySet<string>): string {
  const chosen = patch.hunks.filter((h) => keys.has(h.key));
  return [...patch.header, ...chosen.flatMap((h) => h.text)].join('\n') + '\n';
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
      preview: changed.slice(0, 3),
    };
  });
}
