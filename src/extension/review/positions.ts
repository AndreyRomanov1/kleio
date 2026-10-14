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
