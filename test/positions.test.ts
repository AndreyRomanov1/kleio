import { describe, expect, it } from 'vitest';
import { linePair } from '../src/extension/review/positions';

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
