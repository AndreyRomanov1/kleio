import type { Anchor, Place } from '../anchor';
import type { ShownThread } from '../threadBoard';
import {
  addNote,
  addThread,
  deleteNote,
  findNote,
  findThread,
  type LocalReview,
  type LocalReviewStore,
  type LocalThread,
} from './localReview';

/** Where a local thread stands in the review shown now. */
export interface LocalPlacement {
  places: Place[];
  outdated: boolean;
}

/** The local threads of a review and what can be done with them; each change is saved at once. */
export class LocalThreads {
  constructor(
    private readonly store: LocalReviewStore,
    readonly review: LocalReview,
    /** Who writes the notes typed in the editor. */
    readonly author: string,
  ) {}

  get all(): readonly LocalThread[] {
    return this.review.threads;
  }

  async add(place: { anchor?: Anchor; discussionId?: string }, text: string): Promise<LocalThread> {
    const thread = addThread(this.review, place, this.note(text));
    await this.save();
    return thread;
  }

  async reply(threadId: number, text: string): Promise<void> {
    const thread = findThread(this.review, threadId);
    if (!thread) return;
    addNote(this.review, thread, this.note(text));
    await this.save();
  }

  async edit(noteId: number, text: string): Promise<void> {
    const found = findNote(this.review, noteId);
    if (!found) return;
    found.note.text = text;
    await this.save();
  }

  async delete(noteId: number): Promise<void> {
    deleteNote(this.review, noteId);
    await this.save();
  }

  async resolve(threadId: number, resolved: boolean): Promise<void> {
    const thread = findThread(this.review, threadId);
    if (!thread) return;
    thread.resolved = resolved;
    await this.save();
  }

  /** A thread followed onto another version keeps its new place. */
  async move(threadId: number, anchor: Anchor): Promise<void> {
    const thread = findThread(this.review, threadId);
    if (!thread) return;
    thread.anchor = anchor;
    await this.save();
  }

  save(): Promise<void> {
    return this.store.save(this.review);
  }

  shown(thread: LocalThread, placement: LocalPlacement): ShownThread {
    return {
      ref: { kind: 'local', id: thread.id },
      anchor: thread.anchor,
      places: placement.places,
      notes: thread.notes.map((note) => ({
        ref: { kind: 'local', id: note.id },
        author: note.author,
        text: note.text,
        createdAt: note.createdAt,
        mine: true,
      })),
      resolved: thread.resolved,
      outdated: placement.outdated,
    };
  }

  private note(text: string) {
    return { author: this.author, text, createdAt: new Date().toISOString() };
  }
}
