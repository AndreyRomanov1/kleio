import type { Hunk } from '../git/parse';

export type Side = 'old' | 'new';

export interface LinePair {
  /** 1-based line in the old version; absent for added lines. */
  oldLine?: number;
  /** 1-based line in the new version; absent for removed lines. */
  newLine?: number;
}

/**
 * GitLab places a diff comment by the line of the side it belongs to: an added line by its new number, a removed
 * line by its old number, and an unchanged line by both. Hunks come from `git diff -U0`.
 */
export function linePair(hunks: readonly Hunk[], side: Side, line: number): LinePair {
  let shift = 0;
  for (const hunk of hunks) {
    const start = side === 'new' ? hunk.newStart : hunk.oldStart;
    const count = side === 'new' ? hunk.newLines : hunk.oldLines;
    if (count > 0 && line >= start && line < start + count) {
      return side === 'new' ? { newLine: line } : { oldLine: line };
    }
    // A zero-length side marks the line after which the other side changed.
    const before = count > 0 ? start + count - 1 < line : start < line;
    if (before) shift += hunk.newLines - hunk.oldLines;
  }
  return side === 'new' ? { oldLine: line - shift, newLine: line } : { oldLine: line, newLine: line + shift };
}

/**
 * Both line numbers GitLab keeps for a line of the diff, as its diff parser counts them: an added line also
 * has the old number the old side has reached, a removed line the new one. They make up the `line_code` of
 * the ends of a multi-line comment.
 */
export function lineCounters(hunks: readonly Hunk[], side: Side, line: number): { old: number; new: number } {
  for (const hunk of hunks) {
    const start = side === 'new' ? hunk.newStart : hunk.oldStart;
    const count = side === 'new' ? hunk.newLines : hunk.oldLines;
    if (count > 0 && line >= start && line < start + count) {
      // Within a hunk the removed lines come first, then the added ones.
      return side === 'new'
        ? { old: hunk.oldLines ? hunk.oldStart + hunk.oldLines : hunk.oldStart + 1, new: line }
        : { old: line, new: hunk.newLines ? hunk.newStart : hunk.newStart + 1 };
    }
  }
  const pair = linePair(hunks, side, line);
  return { old: pair.oldLine!, new: pair.newLine! };
}

/**
 * Where a line of a file is after the changes between two versions, by the hunks of their diff; undefined
 * when the line itself was changed.
 */
export function followLine(hunks: readonly Hunk[], line: number): number | undefined {
  let shift = 0;
  for (const hunk of hunks) {
    if (hunk.oldLines > 0 && line >= hunk.oldStart && line < hunk.oldStart + hunk.oldLines) return undefined;
    const before = hunk.oldLines > 0 ? hunk.oldStart + hunk.oldLines - 1 < line : hunk.oldStart < line;
    if (!before) break;
    shift += hunk.newLines - hunk.oldLines;
  }
  return line + shift;
}
