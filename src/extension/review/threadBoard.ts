import * as vscode from 'vscode';
import { t } from '../../shared/l10n';
import { displayLanguage } from '../language';
import type { Anchor, Place } from './anchor';

/** Which thread it is where it is kept: a GitLab discussion, a GitLab draft that starts one, or a local thread. */
export type ThreadRef =
  { kind: 'discussion'; id: string } | { kind: 'draft'; id: number } | { kind: 'local'; id: number };

/** Which comment it is: a note of a GitLab discussion, a GitLab draft, or a note kept on this machine. */
export type NoteRef =
  | { kind: 'note'; discussionId: string; id: number }
  | { kind: 'draft'; id: number }
  | { kind: 'local'; id: number };

export interface ShownNote {
  ref: NoteRef;
  author: string;
  text: string;
  createdAt?: string;
  /** Written by you: it can be edited and deleted. */
  mine: boolean;
}

/** A thread of a review as it is shown in the code, whatever keeps it. */
export interface ShownThread {
  ref: ThreadRef;
  /** Where it was made; absent for a comment on the whole review. */
  anchor?: Anchor;
  /** Every place it stands in: its own version, and where it is followed to. */
  places: Place[];
  notes: ShownNote[];
  /** Absent when the thread cannot be resolved. */
  resolved?: boolean;
  /** Made on an earlier version, and its lines changed since. */
  outdated: boolean;
}

export class ReviewComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  body: vscode.MarkdownString | string;
  author: vscode.CommentAuthorInformation;
  label?: string;
  contextValue: string;
  /** Set once the comment is in a thread, to redraw it when editing starts or ends. */
  thread?: vscode.CommentThread;

  constructor(readonly note: ShownNote) {
    this.body = new vscode.MarkdownString(note.text);
    this.author = { name: note.author };
    const draft = note.ref.kind === 'draft';
    this.label = draft ? t('draft') : note.createdAt ? formatTime(note.createdAt) : undefined;
    // Drafts, local notes and your own notes can be edited and deleted.
    this.contextValue = draft ? 'draft' : note.ref.kind === 'local' ? 'local' : note.mine ? 'mine' : 'note';
  }

  get text(): string {
    return this.note.text;
  }

  /** The text in the box while editing. */
  get edited(): string {
    return (typeof this.body === 'string' ? this.body : this.body.value).trim();
  }

  startEditing(): void {
    this.mode = vscode.CommentMode.Editing;
    this.redraw();
  }

  cancelEditing(): void {
    this.mode = vscode.CommentMode.Preview;
    this.body = new vscode.MarkdownString(this.note.text);
    this.redraw();
  }

  private redraw(): void {
    const thread = this.thread;
    if (thread) thread.comments = thread.comments.map((c) => c);
  }
}

/** The threads of a review in the code: each shown thread at each of its places. */
export class ThreadBoard implements vscode.Disposable {
  private threads: vscode.CommentThread[] = [];
  private readonly shown = new WeakMap<vscode.CommentThread, ShownThread>();
  /** Threads whose comment is on its way: a second Ctrl+Enter or click meanwhile would send it again. */
  private readonly sending = new WeakSet<vscode.CommentThread>();

  constructor(private readonly controller: vscode.CommentController) {}

  get all(): readonly vscode.CommentThread[] {
    return this.threads;
  }

  show(threads: readonly ShownThread[]): void {
    this.clear();
    for (const shown of threads) for (const place of shown.places) this.add(shown, place);
  }

  /** The shown thread a thread in the code stands for; undefined for one being typed. */
  of(thread: vscode.CommentThread): ShownThread | undefined {
    return this.shown.get(thread);
  }

  /** Runs the sending of a comment typed in the thread, unless one is on its way already. */
  async send(thread: vscode.CommentThread, run: () => Promise<void>): Promise<void> {
    if (this.sending.has(thread)) return;
    this.sending.add(thread);
    const label = thread.label;
    thread.label = t('Sending…');
    try {
      await run();
    } finally {
      this.sending.delete(thread);
      thread.label = label;
    }
  }

  /** Where the threads are and what they say. */
  describe(): { uri: string; line: number; comments: string[]; label?: string }[] {
    return this.threads.map((thread) => ({
      uri: thread.uri.toString(),
      line: (thread.range?.start.line ?? 0) + 1,
      comments: thread.comments.map((c) => (typeof c.body === 'string' ? c.body : c.body.value)),
      label: thread.label,
    }));
  }

  clear(): void {
    for (const thread of this.threads) thread.dispose();
    this.threads = [];
  }

  dispose(): void {
    this.clear();
  }

  private add(shown: ShownThread, place: Place): void {
    const comments = shown.notes.map((note) => new ReviewComment(note));
    const thread = this.controller.createCommentThread(place.uri, place.range, comments);
    for (const comment of comments) comment.thread = thread;
    if (shown.ref.kind === 'draft') {
      thread.label = t('Draft');
      thread.contextValue = 'draft';
      thread.canReply = false;
    } else {
      thread.canReply = true;
      if (shown.resolved === undefined) {
        thread.contextValue = 'plain';
      } else {
        thread.state = shown.resolved
          ? vscode.CommentThreadState.Resolved
          : vscode.CommentThreadState.Unresolved;
        const state = shown.resolved ? 'resolved' : 'unresolved';
        // A local thread is answered locally, whatever the review: the menus tell it by the prefix.
        thread.contextValue = shown.ref.kind === 'local' ? `local-${state}` : state;
        thread.label = shown.resolved ? t('Resolved') : undefined;
        thread.collapsibleState = shown.resolved
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
      }
      if (shown.outdated && !shown.resolved) thread.label = t('On the earlier version');
    }
    this.shown.set(thread, shown);
    this.threads.push(thread);
  }
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(displayLanguage(), { dateStyle: 'short', timeStyle: 'short' }).format(date);
}
