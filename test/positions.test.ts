import { describe, expect, it } from 'vitest';
import { followLine, lineCounters, linePair } from '../src/extension/review/positions';

// old: 1 a, 2 b, 3 c, 4 d, 5 e, 6 f
// new: 1 a, 2 B, 3 c, 4 x, 5 y, 6 d, 7 f      (b→B, x and y added after c, e removed)
const hunks = [
  { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
  { oldStart: 3, oldLines: 0, newStart: 4, newLines: 2 },
  { oldStart: 5, oldLines: 1, newStart: 6, newLines: 0 },
];

describe('linePair', () => {
  it('gives changed lines only the number of their own side', () => {
    expect(linePair(hunks, 'new', 2)).toEqual({ newLine: 2 });
    expect(linePair(hunks, 'new', 5)).toEqual({ newLine: 5 });
    expect(linePair(hunks, 'old', 2)).toEqual({ oldLine: 2 });
    expect(linePair(hunks, 'old', 5)).toEqual({ oldLine: 5 });
  });

  it('gives unchanged lines both numbers, shifted by the changes above them', () => {
    expect(linePair(hunks, 'new', 1)).toEqual({ oldLine: 1, newLine: 1 });
    expect(linePair(hunks, 'new', 3)).toEqual({ oldLine: 3, newLine: 3 });
    expect(linePair(hunks, 'new', 6)).toEqual({ oldLine: 4, newLine: 6 });
    expect(linePair(hunks, 'new', 7)).toEqual({ oldLine: 6, newLine: 7 });
    expect(linePair(hunks, 'old', 4)).toEqual({ oldLine: 4, newLine: 6 });
    expect(linePair(hunks, 'old', 6)).toEqual({ oldLine: 6, newLine: 7 });
  });
});

describe('lineCounters', () => {
  // Lines 3–4 replaced by three lines, line 10 removed.
  const hunks = [
    { oldStart: 3, oldLines: 2, newStart: 3, newLines: 3 },
    { oldStart: 10, oldLines: 1, newStart: 10, newLines: 0 },
  ];

  it('gives an added line the old number the old side has reached', () => {
    expect(lineCounters(hunks, 'new', 4)).toEqual({ old: 5, new: 4 });
  });

  it('gives a removed line the new number the new side has reached', () => {
    expect(lineCounters(hunks, 'old', 3)).toEqual({ old: 3, new: 3 });
    expect(lineCounters(hunks, 'old', 10)).toEqual({ old: 10, new: 11 });
  });

  it('gives an unchanged line both of its numbers', () => {
    expect(lineCounters(hunks, 'new', 8)).toEqual({ old: 7, new: 8 });
  });
});

describe('followLine', () => {
  it('moves an unchanged line by the lines added and removed before it', () => {
    expect([1, 3, 4, 6].map((line) => followLine(hunks, line))).toEqual([1, 3, 6, 7]);
  });

  it('loses a changed or removed line', () => {
    expect([2, 5].map((line) => followLine(hunks, line))).toEqual([undefined, undefined]);
  });

  it('keeps every line when nothing changed', () => {
    expect(followLine([], 12)).toBe(12);
  });
});
