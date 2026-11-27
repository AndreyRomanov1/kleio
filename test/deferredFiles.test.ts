import { expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { ChangeSet } from '../src/extension/changes/changeSet';
import { DeferredFiles, ViewedFiles } from '../src/extension/changes/deferredFiles';

function memento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
    update: async (key: string, value: unknown) => void values.set(key, value),
  } as vscode.Memento;
}

function set(right: string, paths: string[], reviewKey?: string): ChangeSet {
  return {
    repository: { root: '/repo' },
    title: right,
    left: 'base',
    right,
    files: paths.map((path) => ({ status: 'M', path })),
    reviewKey,
  } as unknown as ChangeSet;
}

it('keeps deferred files in the order of the set and brings them back', async () => {
  const deferred = new DeferredFiles(memento());
  const files = set('head', ['a.ts', 'b.ts', 'c.ts']);
  expect(await deferred.toggle(files, 'c.ts')).toBe(true);
  expect(await deferred.toggle(files, 'a.ts')).toBe(true);
  expect(deferred.indexes(files)).toEqual([0, 2]);
  expect(await deferred.toggle(files, 'c.ts')).toBe(false);
  expect(deferred.indexes(files)).toEqual([0]);
});

it('keeps the marks of a merge request across its versions and after a reload', async () => {
  const state = memento();
  await new DeferredFiles(state).toggle(set('v1', ['a.ts', 'b.ts'], 'host/project!12'), 'b.ts');
  const reloaded = new DeferredFiles(state);
  expect(reloaded.indexes(set('v2', ['b.ts', 'new.ts'], 'host/project!12'))).toEqual([0]);
  expect(reloaded.indexes(set('v2', ['b.ts'], 'host/project!13'))).toEqual([]);
  expect(reloaded.indexes(set('v1', ['a.ts', 'b.ts']))).toEqual([]);
});

it('forgets the sets touched longest ago', async () => {
  const deferred = new DeferredFiles(memento());
  const first = set('first', ['a.ts']);
  await deferred.toggle(first, 'a.ts');
  for (let i = 0; i < 50; i++) await deferred.toggle(set(`head${i}`, ['a.ts']), 'a.ts');
  expect(deferred.indexes(first)).toEqual([]);
  expect(deferred.indexes(set('head0', ['a.ts']))).toEqual([0]);
});

it('keeps viewed files for the very version, apart from deferred ones', async () => {
  const state = memento();
  const viewed = new ViewedFiles(state);
  await viewed.mark(set('v1', ['a.ts', 'b.ts'], 'host/project!12'), 'b.ts');
  await viewed.mark(set('v1', ['a.ts', 'b.ts'], 'host/project!12'), 'b.ts');
  expect(new ViewedFiles(state).indexes(set('v1', ['a.ts', 'b.ts']))).toEqual([1]);
  expect(viewed.indexes(set('v2', ['a.ts', 'b.ts'], 'host/project!12'))).toEqual([]);
  expect(new DeferredFiles(state).indexes(set('v1', ['a.ts', 'b.ts']))).toEqual([]);
});
