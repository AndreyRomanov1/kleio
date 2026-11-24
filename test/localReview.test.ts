import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  addNote,
  addThread,
  deleteNote,
  emptyReview,
  findNote,
  LocalReviewStore,
} from '../src/extension/review/local/localReview';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kleio-local-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const note = (text: string) => ({ author: 'Ann', text, createdAt: '2026-11-24T10:00:00.000Z' });

const anchor = {
  baseSha: 'b',
  headSha: 'h',
  oldPath: 'a.ts',
  newPath: 'a.ts',
  side: 'new' as const,
  line: 3,
};

it('gives threads and notes ids that never repeat', () => {
  const review = emptyReview('/repo', 'branch:feature', 'feature');
  const first = addThread(review, { anchor }, note('one'));
  const reply = addNote(review, first, note('two'));
  deleteNote(review, reply.id);
  const second = addThread(review, {}, note('three'));
  expect([first.id, reply.id, second.id, second.notes[0].id]).toEqual([1, 3, 4, 5]);
});

it('removes a thread with its last note', () => {
  const review = emptyReview('/repo', 'branch:feature', 'feature');
  const thread = addThread(review, { anchor }, note('one'));
  addNote(review, thread, note('two'));
  deleteNote(review, thread.notes[0].id);
  expect(review.threads).toHaveLength(1);
  deleteNote(review, thread.notes[0].id);
  expect(review.threads).toHaveLength(0);
  expect(findNote(review, 2)).toBeUndefined();
});

it('keeps a review per repository and key', async () => {
  const store = new LocalReviewStore(directory);
  const review = emptyReview('/repo', 'branch:feature', 'feature');
  addThread(review, { anchor }, note('one'));
  await store.save(review);
  expect(await store.load('/repo', 'branch:feature')).toEqual(review);
  expect(await store.load('/repo', 'branch:other')).toBeUndefined();
  expect(await store.load('/other', 'branch:feature')).toBeUndefined();
});

it('leaves no file for a review without threads and no temporary files', async () => {
  const store = new LocalReviewStore(directory);
  const review = emptyReview('/repo', 'range:a..b', 'a..b');
  addThread(review, {}, note('one'));
  await store.save(review);
  expect(await readdir(directory)).toHaveLength(1);
  deleteNote(review, 2);
  await store.save(review);
  expect(await readdir(directory)).toEqual([]);
});

it('writes the saves of one review in order', async () => {
  const store = new LocalReviewStore(directory);
  const review = emptyReview('/repo', 'branch:feature', 'feature');
  const saves = [];
  for (let i = 0; i < 20; i++) {
    addThread(review, {}, note(`n${i}`));
    saves.push(store.save(structuredClone(review)));
  }
  await Promise.all(saves);
  expect((await store.load('/repo', 'branch:feature'))?.threads).toHaveLength(20);
});

it('refuses a file of an unknown version instead of losing it', async () => {
  const store = new LocalReviewStore(directory);
  await writeFile(store.file('/repo', 'k'), JSON.stringify({ version: 2 }));
  await expect(store.load('/repo', 'k')).rejects.toThrow(/version 2/);
});
