import { layoutGraph, type GraphLayout } from '../shared/graph';
import {
  isEmptyQuery,
  type Commit,
  type CommitDetails,
  type LogQuery,
  type Ref,
  type RepositorySnapshot,
  type Stash,
  type Worktree,
} from '../shared/model';
import type {
  ChangeSetView,
  HostingView,
  HostMessage,
  MergeRequestCardView,
  RepositoryInfo,
} from '../shared/protocol';

export interface CardState {
  number: number;
  loading: boolean;
  card?: MergeRequestCardView;
  needsAuth?: boolean;
  error?: string;
}
import { post } from './vscode';

export interface Decorations {
  refs: Ref[];
  isHead: boolean;
  worktrees: Worktree[];
}

export interface Details {
  commits: CommitDetails[];
  changeSet: ChangeSetView;
}

/** Everything the log UI shows, filled from host messages. Large lists are kept raw (not deeply reactive). */
export class LogStore {
  repositories = $state.raw<RepositoryInfo[]>([]);
  snapshot = $state.raw<RepositorySnapshot | undefined>(undefined);
  focus = $state.raw<string[]>([]);
  /** Filters git applied to the loaded log. */
  query = $state.raw<LogQuery>({});
  favorites = $state.raw<string[]>([]);
  hosting = $state.raw<HostingView | undefined>(undefined);
  card = $state.raw<CardState | undefined>(undefined);
  /** Title of the history view; undefined in the regular log. */
  history = $state<string | undefined>(undefined);
  loading = $state(false);
  noRepository = $state(false);
  filterText = $state('');
  selected = $state.raw<ReadonlySet<string>>(new Set());
  details = $state.raw<Details | undefined>(undefined);
  /** Merged merge requests the API found for older history, kept across reloads of the hosting details. */
  private merged?: Extract<HostMessage, { type: 'mergedMergeRequests' }>;
  private mergedPending = false;
  private morePending = false;

  /** Bumped to ask the commit list to scroll to the first selected commit. */
  revealRequest = $state(0);

  private anchor?: string;
  private drag?: { from: string; base: ReadonlySet<string>; moved: boolean };
  private requestId = 0;
  private pendingReveal?: string;

  layout: GraphLayout = $derived(layoutGraph(this.snapshot?.commits ?? []));

  indexByHash: ReadonlyMap<string, number> = $derived(
    new Map((this.snapshot?.commits ?? []).map((c, i) => [c.hash, i])),
  );

  decorations: ReadonlyMap<string, Decorations> = $derived.by(() => {
    const map = new Map<string, Decorations>();
    const snapshot = this.snapshot;
    if (!snapshot) return map;
    const get = (hash: string) => {
      let d = map.get(hash);
      if (!d) map.set(hash, (d = { refs: [], isHead: false, worktrees: [] }));
      return d;
    };
    for (const ref of snapshot.refs) get(ref.hash).refs.push(ref);
    if (snapshot.head.hash) get(snapshot.head.hash).isHead = true;
    for (const worktree of snapshot.worktrees)
      if (worktree.head && !worktree.isCurrent) get(worktree.head).worktrees.push(worktree);
    return map;
  });

  /**
   * Merge requests by commit as the log rows show them. A merged one is marked on its merge commit only: the
   * head of its branch, which the server keeps a ref to, is a parent of that merge right below it. Branches
   * still find their merge request by the head in {@link hosting}.
   */
  logMergeRequests: Readonly<Record<string, number[]>> = $derived.by(() => {
    const byCommit = this.hosting?.mergeRequests ?? {};
    const commits = this.snapshot?.commits ?? [];
    const hidden = new Set<string>();
    for (const [hash, numbers] of Object.entries(byCommit)) {
      const index = this.indexByHash.get(hash);
      const parents = index === undefined ? [] : commits[index].parents.slice(1);
      for (const parent of parents)
        for (const n of numbers) if (byCommit[parent]?.includes(n)) hidden.add(`${parent} ${n}`);
    }
    if (!hidden.size) return byCommit;
    return Object.fromEntries(
      Object.entries(byCommit).map(([hash, numbers]) => [
        hash,
        numbers.filter((n) => !hidden.has(`${hash} ${n}`)),
      ]),
    );
  });

  /** Commits of the current branch: what interactive rebase can rewrite. */
  headAncestors: ReadonlySet<string> = $derived.by(() => {
    const result = new Set<string>();
    const snapshot = this.snapshot;
    if (!snapshot?.head.hash || !snapshot.head.branch) return result;
    const commits = snapshot.commits;
    const stack = [snapshot.head.hash];
    while (stack.length) {
      const hash = stack.pop()!;
      if (result.has(hash)) continue;
      const index = this.indexByHash.get(hash);
      if (index === undefined) continue;
      result.add(hash);
      stack.push(...commits[index].parents);
    }
    return result;
  });

  /** Indexes of commits passing the text filter; undefined when no filter is set. */
  filtered: number[] | undefined = $derived.by(() => {
    const text = this.filterText.trim().toLowerCase();
    const commits = this.snapshot?.commits;
    if (!text || !commits) return undefined;
    const result: number[] = [];
    commits.forEach((c, i) => {
      if (
        c.subject.toLowerCase().includes(text) ||
        c.authorName.toLowerCase().includes(text) ||
        c.authorEmail.toLowerCase().includes(text) ||
        c.hash.startsWith(text)
      ) {
        result.push(i);
      }
    });
    return result;
  });

  get rowCount(): number {
    return this.filtered?.length ?? this.snapshot?.commits.length ?? 0;
  }

  commitIndexAt(row: number): number {
    return this.filtered ? this.filtered[row] : row;
  }

  rowOf(hash: string): number | undefined {
    const index = this.indexByHash.get(hash);
    if (index === undefined) return undefined;
    if (!this.filtered) return index;
    const row = this.filtered.indexOf(index);
    return row < 0 ? undefined : row;
  }

  handle(message: HostMessage): void {
    switch (message.type) {
      case 'snapshot':
        this.noRepository = false;
        this.repositories = message.repositories;
        this.snapshot = message.snapshot;
        this.morePending = false;
        this.focus = message.focus;
        this.query = message.query;
        this.favorites = message.favorites;
        this.history = message.history?.title;
        this.afterSnapshot();
        break;
      case 'noRepository':
        this.noRepository = true;
        break;
      case 'loading':
        this.loading = message.value;
        break;
      case 'details':
        if (message.requestId === this.requestId)
          this.details = { commits: message.commits, changeSet: message.changeSet };
        break;
      case 'revealCommit':
        this.reveal(message.hash);
        break;
      case 'hosting':
        // Merged merge requests of another remote's hosting are of no use.
        if (this.hosting && message.hosting.remote !== this.hosting.remote) {
          this.merged = undefined;
          this.mergedPending = false;
        }
        this.hosting = this.withMerged(message.hosting);
        break;
      case 'mergedMergeRequests':
        this.merged = {
          ...message,
          byCommit: { ...this.merged?.byCommit, ...message.byCommit },
          info: { ...this.merged?.info, ...message.info },
        };
        this.mergedPending = false;
        if (this.hosting) this.hosting = this.withMerged(this.hosting);
        break;
      case 'mergeRequestCard':
        if (this.card?.number === message.number) {
          this.card = {
            number: message.number,
            loading: false,
            card: message.card,
            needsAuth: message.needsAuth,
            error: message.error,
          };
        }
        break;
    }
  }

  /** Selection handling for clicks: plain, with Ctrl/Cmd (toggle) and with Shift (range). */
  click(hash: string, toggle: boolean, range: boolean): void {
    if (range && this.anchor !== undefined) {
      const from = this.rowOf(this.anchor);
      const to = this.rowOf(hash);
      if (from !== undefined && to !== undefined) {
        const next = new Set<string>();
        for (let r = Math.min(from, to); r <= Math.max(from, to); r++) next.add(this.commitAt(r).hash);
        this.select(next);
        return;
      }
    }
    if (toggle) {
      const next = new Set(this.selected);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      this.anchor = hash;
      this.select(next);
      return;
    }
    this.anchor = hash;
    this.select(new Set([hash]));
  }

  /**
   * Selection by dragging with the left button held: from the commit pressed (or the anchor with Shift) to the
   * one under the pointer; with Ctrl the range is added to what was selected. Details load once at the end.
   */
  dragStart(hash: string, toggle: boolean, range: boolean): void {
    const from = range && this.anchor !== undefined ? this.anchor : hash;
    this.click(hash, toggle, range);
    this.drag = { from, base: toggle ? new Set(this.selected) : new Set(), moved: false };
  }

  dragTo(hash: string): void {
    const drag = this.drag;
    // Until the pointer leaves the commit pressed, it is a click: a Ctrl+click that unselected it stays so.
    if (!drag || (!drag.moved && hash === drag.from)) return;
    const from = this.rowOf(drag.from);
    const to = this.rowOf(hash);
    if (from === undefined || to === undefined) return;
    const next = new Set(drag.base);
    for (let r = Math.min(from, to); r <= Math.max(from, to); r++) next.add(this.commitAt(r).hash);
    if (next.size === this.selected.size && [...next].every((h) => this.selected.has(h))) return;
    drag.moved = true;
    this.selected = next;
  }

  dragEnd(): void {
    const drag = this.drag;
    this.drag = undefined;
    if (drag?.moved) this.select(new Set(this.selected));
  }

  /** Moves the selection with the keyboard. */
  step(delta: number, extend: boolean): void {
    if (this.rowCount === 0) return;
    const current = this.lastSelectedRow();
    const row = Math.max(0, Math.min(this.rowCount - 1, (current ?? -1) + delta));
    const hash = this.commitAt(row).hash;
    if (extend) {
      this.click(hash, false, true);
    } else {
      this.anchor = hash;
      this.select(new Set([hash]));
    }
    this.revealRequest++;
  }

  reveal(hash: string): void {
    if (this.indexByHash.has(hash)) {
      this.filterText = '';
      this.anchor = hash;
      this.select(new Set([hash]));
      this.revealRequest++;
    } else {
      this.pendingReveal = hash;
      // The commit may be hidden by the focus on branches or by the filters: show everything to find it.
      if (!isEmptyQuery(this.query)) post({ type: 'setQuery', query: {} });
      if (this.focus.length) post({ type: 'setFocus', revisions: [] });
    }
  }

  /** The merge request card, or the browser when the hosting has no API to show it with. */
  openCard(number: number): void {
    if (this.hosting?.api === 'none' || !this.hosting?.kind) {
      post({ type: 'openMergeRequest', number });
      return;
    }
    this.card = { number, loading: true, card: this.card?.number === number ? this.card.card : undefined };
    post({ type: 'loadMergeRequestCard', number });
  }

  closeCard(): void {
    this.card = undefined;
  }

  showStash(stash: Stash): void {
    this.selected = new Set();
    this.details = undefined;
    post({ type: 'showStash', requestId: ++this.requestId, hash: stash.hash });
  }

  /**
   * Asks for merged merge requests down to the commit shown lowest on screen, unless they are loaded already;
   * the server's merge request refs only cover the last weeks.
   */
  /** Asks for older commits once the end of a truncated log comes into view. */
  wantMoreCommits(): void {
    if (!this.snapshot?.truncated || this.morePending) return;
    this.morePending = true;
    post({ type: 'loadMoreCommits' });
  }

  wantMergedBefore(date: number): void {
    if (this.history || this.hosting?.api !== 'available' || this.mergedPending) return;
    const merged = this.merged;
    if (merged?.done || (merged?.coveredUntil !== undefined && merged.coveredUntil < date)) return;
    this.mergedPending = true;
    post({ type: 'loadMergedMergeRequests', before: date });
  }

  private withMerged(hosting: HostingView): HostingView {
    const merged = this.merged;
    if (!merged) return hosting;
    const byCommit = { ...merged.byCommit };
    for (const [commit, numbers] of Object.entries(hosting.mergeRequests))
      byCommit[commit] = [...new Set([...numbers, ...(byCommit[commit] ?? [])])];
    return {
      ...hosting,
      mergeRequests: byCommit,
      mergeRequestInfo: { ...merged.info, ...hosting.mergeRequestInfo },
    };
  }

  commitAt(row: number): Commit {
    return this.snapshot!.commits[this.commitIndexAt(row)];
  }

  private lastSelectedRow(): number | undefined {
    if (this.anchor === undefined) return undefined;
    return this.rowOf(this.anchor);
  }

  private select(hashes: Set<string>): void {
    this.selected = hashes;
    const ordered = [...hashes].sort(
      (a, b) => (this.indexByHash.get(a) ?? 0) - (this.indexByHash.get(b) ?? 0),
    );
    if (ordered.length === 0) {
      this.details = undefined;
      return;
    }
    post({ type: 'selectCommits', requestId: ++this.requestId, hashes: ordered });
  }

  private afterSnapshot(): void {
    if (this.pendingReveal && this.indexByHash.has(this.pendingReveal)) {
      const hash = this.pendingReveal;
      this.pendingReveal = undefined;
      this.reveal(hash);
      return;
    }
    const kept = [...this.selected].filter((h) => this.indexByHash.has(h));
    if (kept.length > 0) {
      if (kept.length !== this.selected.size) this.select(new Set(kept));
      return;
    }
    // The log starts at HEAD; a history view, or a log whose filters hide HEAD, at its latest commit.
    const head = this.snapshot?.head.hash;
    const start =
      !this.history && head && this.indexByHash.has(head) ? head : this.snapshot?.commits[0]?.hash;
    if (start) {
      this.anchor = start;
      this.select(new Set([start]));
      this.revealRequest++;
    } else {
      this.selected = new Set();
      this.details = undefined;
    }
  }
}
