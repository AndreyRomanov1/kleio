import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Anchor } from '../anchor';

export interface LocalNote {
  id: number;
  author: string;
  text: string;
  /** ISO time. */
  createdAt: string;
}

/**
 * A thread kept on this machine: on lines of a version of the changes, on a merge request discussion (local
 * replies to it, `discussionId`) or on the changes as a whole (neither).
 */
export interface LocalThread {
  /** Shown as `T<id>`; outside tools refer to the thread by it. */
  id: number;
  anchor?: Anchor;
  discussionId?: string;
  resolved: boolean;
  notes: LocalNote[];
}

/** The local threads of one review: a branch, a range of commits or a merge request. */
export interface LocalReview {
  version: 1;
  root: string;
  /** `branch:<name>`, `range:<base>..<head>` or the label of a merge request. */
  key: string;
  title: string;
  /** Threads and notes share it, so an id never comes back after a deletion. */
  nextId: number;
  threads: LocalThread[];
}

export function emptyReview(root: string, key: string, title: string): LocalReview {
  return { version: 1, root, key, title, nextId: 1, threads: [] };
}

export function addThread(
  review: LocalReview,
  place: { anchor?: Anchor; discussionId?: string },
  note: Omit<LocalNote, 'id'>,
): LocalThread {
  const thread: LocalThread = { id: review.nextId++, ...place, resolved: false, notes: [] };
  review.threads.push(thread);
  addNote(review, thread, note);
  return thread;
}

export function addNote(review: LocalReview, thread: LocalThread, note: Omit<LocalNote, 'id'>): LocalNote {
  const added = { id: review.nextId++, ...note };
  thread.notes.push(added);
  return added;
}

export function findThread(review: LocalReview, id: number): LocalThread | undefined {
  return review.threads.find((t) => t.id === id);
}

export function findNote(
  review: LocalReview,
  id: number,
): { thread: LocalThread; note: LocalNote } | undefined {
  for (const thread of review.threads) {
    const note = thread.notes.find((n) => n.id === id);
    if (note) return { thread, note };
  }
  return undefined;
}

/** Removes a note; a thread left without notes goes too. */
export function deleteNote(review: LocalReview, id: number): void {
  const found = findNote(review, id);
  if (!found) return;
  found.thread.notes = found.thread.notes.filter((n) => n.id !== id);
  if (!found.thread.notes.length) review.threads = review.threads.filter((t) => t !== found.thread);
}

/**
 * Local reviews as JSON files in the storage of the extension, one per review. A file is replaced whole through
 * a temporary one, so a crash leaves the old content or the new one, never a mix.
 */
export class LocalReviewStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  async load(root: string, key: string): Promise<LocalReview | undefined> {
    const file = this.file(root, key);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const review = JSON.parse(text) as LocalReview;
    // Not overwritten by an older Kleio: its threads would be lost.
    if (review.version !== 1) throw new Error(`Unsupported local review version ${review.version}: ${file}`);
    return review;
  }

  /** Writes the review; one without threads leaves no file. Saves of one review go in order. */
  save(review: LocalReview): Promise<void> {
    const file = this.file(review.root, review.key);
    const content = review.threads.length ? JSON.stringify(review, null, 2) + '\n' : undefined;
    const write = (this.writes.get(file) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.write(file, content));
    this.writes.set(file, write);
    return write;
  }

  file(root: string, key: string): string {
    const hash = createHash('sha1').update(`${root}\n${key}`).digest('hex');
    return path.join(this.directory, `${hash}.json`);
  }

  private async write(file: string, content: string | undefined): Promise<void> {
    if (content === undefined) {
      await rm(file, { force: true });
      return;
    }
    await mkdir(this.directory, { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, file);
  }
}
