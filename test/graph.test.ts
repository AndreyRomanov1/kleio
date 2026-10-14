import { describe, expect, it } from 'vitest';
import { layoutGraph, type GraphCommit } from '../src/shared/graph';

const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents });

describe('layoutGraph', () => {
  it('keeps a linear history on a single lane', () => {
    const { rows, maxWidth } = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);

    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
    expect(maxWidth).toBe(1);
    expect(rows[2].segments).toEqual([{ x1: 0, y1: 0, x2: 0, y2: 0.5, color: rows[2].color }]);
  });

  it('puts a merged branch on its own lane and joins it back at the fork point', () => {
    // m merges f into main; f and b both descend from a.
    const { rows } = layoutGraph([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')]);

    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    expect(rows[0].segments).toContainEqual({ x1: 0, y1: 0.5, x2: 1, y2: 1, color: rows[1].color });
    expect(rows[3].segments).toContainEqual({ x1: 1, y1: 0, x2: 0, y2: 0.5, color: rows[1].color });
    expect(rows[1].color).not.toBe(rows[0].color);
  });

  it('starts a new lane for an unrelated branch tip', () => {
    const { rows } = layoutGraph([c('x', 'a'), c('y', 'a'), c('a')]);

    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expect(rows[1].segments).toContainEqual({ x1: 0, y1: 0, x2: 0, y2: 1, color: rows[0].color });
  });

  it('reuses a freed lane instead of growing the graph', () => {
    const { rows, maxWidth } = layoutGraph([c('x', 'b'), c('y', 'b'), c('b', 'a'), c('z', 'a'), c('a')]);

    expect(rows[3].lane).toBe(1);
    expect(maxWidth).toBe(2);
  });

  it('keeps the merged-in lane color through the whole side branch', () => {
    const { rows } = layoutGraph([c('m', 'b', 'f2'), c('f2', 'f1'), c('f1', 'a'), c('b', 'a'), c('a')]);

    expect(rows[1].color).toBe(rows[2].color);
    expect(rows[1].lane).toBe(rows[2].lane);
  });
});
