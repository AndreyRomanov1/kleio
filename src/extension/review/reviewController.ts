import * as vscode from 'vscode';
import type { ChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import type { Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import { GitLabApiError, type DiffPosition } from '../hosting/gitlabApi';
import type { HostingService } from '../hosting/hostingService';
import { revealOld, sidesOf, type Anchor } from './anchor';
import { moveToComment, shownSet } from './commentNavigation';
import { MergeRequestSession } from './mergeRequest/mergeRequestSession';
import { NewerVersionOffer } from './mergeRequest/newerVersion';
import { openPullRequest } from './mergeRequest/pullRequestDiff';
import { SeenVersions, type Version } from './mergeRequest/seenVersions';
import type { ReviewJournal } from './reviewJournal';
import { ThreadBoard, type ReviewComment } from './threadBoard';
import { t } from '../../shared/l10n';

const CONTROLLER_ID = 'kleio.review';
const CONTEXT_KEY = 'kleio.reviewActive';
/** New comments and versions are looked for at most this often without a click. */
const REFRESH_MS = 30_000;
/** The review open in this workspace, to bring it back after a reload of the window. */
const ACTIVE_KEY = 'kleio.review.active';

/**
 * Reviewing a GitLab merge request in the regular diff viewer: existing discussions are shown in the code,
 * new comments are published at once or saved as GitLab drafts ("pending comments") to submit together.
 */
export class ReviewController implements vscode.Disposable {
  private session?: MergeRequestSession;
  private following = false;
  private reloadedAt = 0;
  private readonly seen: SeenVersions;
  private readonly comments: vscode.CommentController;
  private readonly board: ThreadBoard;
  private readonly newer = new NewerVersionOffer(() => this.session);
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly hosting: HostingService,
    private readonly navigator: ChangeSetNavigator,
    private readonly journal: ReviewJournal,
    state: vscode.Memento,
    private readonly workspaceState?: vscode.Memento,
  ) {
    this.seen = new SeenVersions(state);
    this.comments = vscode.comments.createCommentController(CONTROLLER_ID, t('Merge request review'));
    this.comments.options = {
      placeHolder: t('Comment on the line'),
      prompt: t('Comment on the merge request'),
    };
    this.comments.commentingRangeProvider = {
      provideCommentingRanges: (document) =>
        this.session?.documents.has(document.uri.toString())
          ? [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)]
          : [],
    };
    this.board = new ThreadBoard(this.comments);
    this.disposables = [
      this.board,
      this.comments,
      this.newer,
      vscode.commands.registerCommand('kleio.review.publish', (reply: vscode.CommentReply) =>
        this.send(reply, 'publish'),
      ),
      vscode.commands.registerCommand('kleio.review.draft', (reply: vscode.CommentReply) =>
        this.send(reply, 'draft'),
      ),
      vscode.commands.registerCommand('kleio.review.resolve', (thread: vscode.CommentThread) =>
        this.resolve(thread, true),
      ),
      vscode.commands.registerCommand('kleio.review.unresolve', (thread: vscode.CommentThread) =>
        this.resolve(thread, false),
      ),
      vscode.commands.registerCommand('kleio.review.deleteDraft', (comment: ReviewComment) =>
        this.deleteDraft(comment),
      ),
      vscode.commands.registerCommand('kleio.review.editComment', (comment: ReviewComment) =>
        comment.startEditing(),
      ),
      vscode.commands.registerCommand('kleio.review.saveComment', (comment: ReviewComment) =>
        this.saveComment(comment),
      ),
      vscode.commands.registerCommand('kleio.review.cancelEdit', (comment: ReviewComment) =>
        comment.cancelEditing(),
      ),
      vscode.commands.registerCommand('kleio.review.deleteComment', (comment: ReviewComment) =>
        this.deleteComment(comment),
      ),
      vscode.commands.registerCommand('kleio.review.publishDrafts', () => this.publishDrafts()),
      vscode.commands.registerCommand('kleio.review.refresh', () => this.reload()),
      vscode.commands.registerCommand('kleio.review.end', () => this.end()),
      vscode.commands.registerCommand('kleio.review.sinceLastReview', () => this.sinceLastReview()),
      vscode.commands.registerCommand('kleio.review.openJournal', () => this.journal.open()),
      vscode.commands.registerCommand('kleio.review.nextComment', () => this.moveToComment(1)),
      vscode.commands.registerCommand('kleio.review.previousComment', () => this.moveToComment(-1)),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.refreshQuietly();
      }),
      vscode.commands.registerCommand('kleio.review.newVersion', () => this.newer.menu()),
      vscode.commands.registerCommand('kleio.review.compareNewer', () => this.compareNewer()),
      vscode.commands.registerCommand('kleio.review.switchToNewer', () => this.switchToNewer()),
      vscode.commands.registerCommand('kleio.review.stayOnVersion', () => this.newer.dismiss()),
    ];
  }

  get activeMergeRequest(): number | undefined {
    return this.session?.iid;
  }

  /** Threads shown in the code: where they are and what they say. */
  openThreads(): { uri: string; line: number; comments: string[]; label?: string }[] {
    return this.board.describe();
  }

  /**
   * Opens the merge request diff (what GitLab shows) and its discussions; `filePath` and `line` to jump to. An
   * outdated `discussion` opens in the version of the merge request it was made on.
   */
  async start(
    repository: Repository,
    iid: number,
    filePath?: string,
    line?: number,
    discussion?: string,
  ): Promise<void> {
    if ((await this.hosting.known(repository))?.links?.kind === 'github')
      return openPullRequest(this.hosting, this.navigator, repository, iid, filePath, line);
    if (!(await this.ensureSession(repository, iid))) return;
    const session = this.session!;
    const outdated = discussion === undefined ? undefined : session.outdated.get(discussion);
    if (outdated && (await this.openOutdated(session, outdated))) return;
    if (session.changeSet.files.length === 0) {
      void vscode.window.showInformationMessage(t('Merge request !{0} has no changes.', iid));
      return;
    }
    const index = filePath
      ? session.changeSet.files.findIndex((f) => f.path === filePath || f.oldPath === filePath)
      : 0;
    await this.navigator.open(session.changeSet, Math.max(0, index), 'first', {
      line: line === undefined ? undefined : line - 1,
    });
    await this.looked(session);
  }

  /**
   * The diff of the merge request is shown: its version counts as looked at, and a version new to you offers
   * what changed since the one you looked at before.
   */
  private async looked(session: MergeRequestSession): Promise<void> {
    const isNew = this.seen.of(session.label).at(-1)?.headSha !== session.refs.headSha;
    await this.seen.mark(session.label, session.current);
    if (isNew && session.previous) this.offerSinceLastReview(session);
  }

  /** A merge request opened by hand: its session, taken up or made, with the comments in the code. */
  private async ensureSession(repository: Repository, iid: number): Promise<boolean> {
    const existing = this.session;
    if (existing?.iid === iid && existing.repository === repository) {
      existing.auto = false;
      await this.renewIfUpdated(existing, true);
      if (this.session) this.session.auto = false;
      return true;
    }
    const session = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Kleio: review of !{0}', iid) },
      () => this.createSession(repository, iid),
    );
    if (!session) return false;
    this.end();
    this.begin(session);
    await this.reload();
    return true;
  }

  /**
   * The merge request of the current branch has its comments in the code with nothing to start or end: on its
   * diff and on the files that are the same on disk. One opened by hand stays until another one is opened.
   * Not a look at the merge request: no version counts as looked at.
   */
  async follow(repository: Repository, iid: number | undefined): Promise<void> {
    const session = this.session;
    if (session && !session.auto) {
      if (session.iid === iid && session.repository === repository) await this.refreshQuietly();
      return;
    }
    if (session && session.iid === iid && session.repository === repository) return this.refreshQuietly();
    if (iid === undefined) {
      if (session?.repository === repository) this.end();
      return;
    }
    if (this.following) return;
    this.following = true;
    try {
      const created = await this.createSession(repository, iid, true).catch(() => undefined);
      if (!created || this.session !== session) return;
      created.auto = true;
      this.end();
      this.begin(created);
      await this.reload();
    } finally {
      this.following = false;
    }
  }

  /** New comments and versions without a click: when the window is back in focus or the log refreshes. */
  private async refreshQuietly(): Promise<void> {
    if (!this.session || Date.now() - this.reloadedAt < REFRESH_MS) return;
    await this.reload();
  }

  /** Not awaited: the review is open already, the offer only narrows it down. */
  private offerSinceLastReview(session: MergeRequestSession): void {
    const only = t('Show only what changed');
    void vscode.window
      .showInformationMessage(
        t(
          '!{0} has changed since your last review ({1} → {2}).',
          session.iid,
          session.previous!.headSha.slice(0, 8),
          session.refs.headSha.slice(0, 8),
        ),
        only,
      )
      .then((choice) => {
        if (choice === only && this.session === session) return this.sinceLastReview();
      });
  }

  /** The changes of the merge request since the version looked at last time. */
  private async sinceLastReview(): Promise<void> {
    const session = this.session;
    if (!session?.previous) {
      void vscode.window.showInformationMessage(
        t('Kleio has not seen an earlier version of this merge request.'),
      );
      return;
    }
    await this.openInterdiff(session, session.previous, session.current);
  }

  /**
   * Compares two versions of a merge request, or shows one version as GitLab showed it then when `from` is
   * absent. The review goes on in that merge request.
   */
  async compareVersions(
    repository: Repository,
    iid: number,
    from: Version | undefined,
    to: Version,
  ): Promise<void> {
    if (!(await this.ensureSession(repository, iid))) return;
    const session = this.session!;
    if (!from) {
      const set = await session.versionOf(to);
      if (!set) {
        void vscode.window.showWarningMessage(t('The commits of the version are not in the repository.'));
        return;
      }
      if (to.headSha === session.refs.headSha) return this.start(repository, iid);
      await this.navigator.open(set, 0);
      return;
    }
    await this.openInterdiff(session, from, to);
  }

  private async openInterdiff(session: MergeRequestSession, from: Version, to: Version): Promise<void> {
    const interdiff = await session.interdiffOf(from, to);
    if (!interdiff) {
      void vscode.window.showWarningMessage(
        t('The commits of the earlier version are not in the repository any more.'),
      );
      return;
    }
    if (interdiff.conflicted)
      void vscode.window.showWarningMessage(
        t('The earlier version conflicts with the new base: the diff includes the changes of the rebase.'),
      );
    if (!interdiff.files.length) {
      void vscode.window.showInformationMessage(t('{0}: no differences.', interdiff.set.title));
      return;
    }
    // Its comments of the earlier version go on its left side.
    await this.reload();
    await this.navigator.open(interdiff.set, 0);
    if (to.headSha === session.refs.headSha) await this.seen.mark(session.label, to);
  }

  /** Opens an outdated discussion in the version of the merge request it was made on. */
  private async openOutdated(session: MergeRequestSession, anchor: Anchor): Promise<boolean> {
    const set = await session.versionOf(anchor);
    const index =
      set?.files.findIndex((f) => f.path === anchor.newPath || f.oldPath === anchor.oldPath) ?? -1;
    if (!set || index < 0) {
      void vscode.window.showWarningMessage(
        t('The commits of the earlier version are not in the repository any more.'),
      );
      return false;
    }
    const onNew = anchor.side === 'new';
    const line = anchor.line - 1;
    await this.navigator.open(set, index, 'first', { line: onNew ? line : undefined });
    if (!onNew) revealOld(set, index, line);
    return true;
  }

  /** Heads of the versions of a merge request you looked at, for its card. */
  async seenHeads(repository: Repository, iid: number): Promise<string[]> {
    return this.seen.of(await this.label(repository, iid)).map((v) => v.headSha);
  }

  /** Publishes or saves a comment typed outside the code, e.g. a general comment from the merge request card. */
  async postGeneral(
    repository: Repository,
    iid: number,
    text: string,
    kind: 'publish' | 'draft',
  ): Promise<boolean> {
    if ((await this.hosting.known(repository))?.links?.kind === 'github') {
      const github = await this.hosting.github(repository, true);
      if (!github || !text.trim()) return false;
      const label = await this.label(repository, iid);
      return this.deliver({ mergeRequest: label, kind: 'publish', target: 'MR', text }, async () => {
        const { card } = await github.pullRequestCard(iid);
        await github.comment(card.id, text);
      });
    }
    const api = await this.hosting.gitlab(repository, true);
    if (!api || !text.trim()) return false;
    const label = await this.label(repository, iid);
    return this.deliver({ mergeRequest: label, kind, target: 'MR', text }, () =>
      kind === 'publish' ? api.createDiscussion(iid, text) : api.createDraftNote(iid, text, {}),
    );
  }

  async publishDraftsOf(repository: Repository, iid: number): Promise<void> {
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    await api.publishDraftNotes(iid);
    vscode.window.setStatusBarMessage(t('Kleio: drafts of !{0} are published', iid), 4000);
    if (this.session?.iid === iid) await this.reload();
  }

  private begin(session: MergeRequestSession): void {
    this.session = session;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
    void this.workspaceState?.update(ACTIVE_KEY, { root: session.repository.root, iid: session.iid });
  }

  /**
   * The review that was open before the window was reloaded, with its comments in the code; quietly, without
   * asking for access. The restored diff tab belongs to it again.
   */
  async restore(repositories: RepositoryManager): Promise<void> {
    const saved = this.workspaceState?.get<{ root: string; iid: number }>(ACTIVE_KEY);
    if (!saved || this.session) return;
    const repository = await repositories.get(saved.root);
    if (!repository) return;
    const session = await this.createSession(repository, saved.iid, true).catch(() => undefined);
    if (!session || this.session) return;
    this.begin(session);
    const since = await session.since();
    await this.reload();
    await this.navigator.restore(repositories, [session.changeSet, ...(since ? [since.set] : [])]);
  }

  private async createSession(
    repository: Repository,
    iid: number,
    quiet = false,
  ): Promise<MergeRequestSession | undefined> {
    const api = await this.hosting.gitlab(repository, !quiet);
    if (!api) {
      if (!quiet) void vscode.window.showWarningMessage(t('The review needs access to GitLab.'));
      return undefined;
    }
    const remote = (await this.hosting.known(repository))?.remoteName ?? 'origin';
    const label = await this.label(repository, iid);
    const session = await MergeRequestSession.open(api, repository, remote, iid, label, this.seen);
    if (session === 'noVersions')
      void vscode.window.showWarningMessage(t('GitLab returned no diff versions for !{0}.', iid));
    else if (session === 'noCommits')
      void vscode.window.showErrorMessage(t('Could not fetch the commits of !{0} from {1}.', iid, remote));
    else return session;
    return undefined;
  }

  private async reload(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.reloadedAt = Date.now();
    if (await this.renewIfUpdated(session, false)) return;
    const newerOnly = session.newerOnly;
    let threads;
    try {
      threads = await session.threads();
    } catch (error) {
      void vscode.window.showErrorMessage(t('Kleio: the discussions did not load: {0}', message(error)));
      return;
    }
    if (session !== this.session) return;
    if (session.newerOnly !== newerOnly) this.newer.refreshLenses();
    this.board.show(threads);
  }

  /**
   * After a push the merge request has a newer version. While the diff of this one is open the review stays on
   * it, as a GitLab page does until it is reloaded, and the newer one is offered next to the diff; otherwise,
   * or when the merge request is opened by hand, the review moves on to the newer one quietly.
   */
  private async renewIfUpdated(session: MergeRequestSession, explicit: boolean): Promise<boolean> {
    const head = await session.api
      .mergeRequest(session.iid)
      .then((details) => details.diffRefs)
      .catch(() => undefined);
    if (!head || session !== this.session) return false;
    if (head.headSha === session.refs.headSha) {
      if (session.newer) this.newer.offer(session, undefined);
      return false;
    }
    if (!explicit && this.showing(session)) {
      if (session.newer?.headSha !== head.headSha) {
        await session.ensureVersionCommits([head.baseSha, head.headSha]);
        await session.refreshNumbers();
        const created = await session.api
          .versions(session.iid)
          .then((versions) => versions.find((v) => v.headSha === head.headSha)?.createdAt)
          .catch(() => undefined);
        this.newer.offer(session, {
          baseSha: head.baseSha,
          headSha: head.headSha,
          number: session.numbers.get(head.headSha),
          createdAt: created,
        });
      }
      return false;
    }
    return !!(await this.renew(session));
  }

  private async renew(session: MergeRequestSession): Promise<MergeRequestSession | undefined> {
    const renewed = await this.createSession(session.repository, session.iid, true).catch(() => undefined);
    if (!renewed || session !== this.session) return undefined;
    renewed.auto = session.auto;
    this.end(false);
    this.begin(renewed);
    await this.reload();
    return renewed;
  }

  /** Whether a diff of the review is open in a tab: the merge request, a comparison of versions, a version. */
  private showing(session: MergeRequestSession): boolean {
    const sides = session.ownSets().map(sidesOf);
    return vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .some(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff &&
          sides.some(
            (map) =>
              map.has((tab.input as vscode.TabInputTextDiff).original.toString()) ||
              map.has((tab.input as vscode.TabInputTextDiff).modified.toString()),
          ),
      );
  }

  private async compareNewer(): Promise<void> {
    const session = this.session;
    if (session?.newer) await this.openInterdiff(session, session.current, session.newer);
  }

  /** Goes on to the newer version at the same file and line. */
  private async switchToNewer(): Promise<void> {
    const session = this.session;
    if (!session?.newer) return;
    const shown = this.navigator.shownFile;
    const filePath =
      shown && session.ownSets().includes(shown.changeSet)
        ? shown.changeSet.files[shown.index]?.path
        : undefined;
    const line = vscode.window.activeTextEditor?.selection.active.line;
    const renewed = await this.renew(session);
    if (!renewed || !renewed.changeSet.files.length) return;
    const index = Math.max(
      0,
      renewed.changeSet.files.findIndex((f) => f.path === filePath),
    );
    await this.navigator.open(renewed.changeSet, index, 'first', { line: filePath ? line : undefined });
    await this.looked(renewed);
  }

  private async send(reply: vscode.CommentReply, kind: 'publish' | 'draft'): Promise<void> {
    const session = this.session;
    const text = reply.text.trim();
    if (!session || !text) return;
    await this.board.send(reply.thread, () => this.sendTo(session, reply.thread, text, kind));
  }

  private async sendTo(
    session: MergeRequestSession,
    thread: vscode.CommentThread,
    text: string,
    kind: 'publish' | 'draft',
  ): Promise<void> {
    const ref = this.board.of(thread)?.ref;
    const discussionId = ref?.kind === 'discussion' ? ref.id : undefined;

    let target: string;
    let request: () => Promise<void>;
    if (discussionId) {
      target = t('reply in discussion {0}', discussionId);
      request = () =>
        kind === 'publish'
          ? session.api.reply(session.iid, discussionId, text)
          : session.api.createDraftNote(session.iid, text, { discussionId });
    } else {
      if (!thread.range) return;
      const placed = await session.positionOf(thread.uri, thread.range);
      if (!placed) return;
      const { position } = placed;
      target = placed.target;
      const create = (p: DiffPosition) =>
        kind === 'publish'
          ? session.api.createDiscussion(session.iid, text, p)
          : session.api.createDraftNote(session.iid, text, { position: p });
      // A rejected range still leaves the comment on its last line rather than not at all.
      request = () =>
        create(position).catch((error: unknown) => {
          if (!position.lineRange || !(error instanceof GitLabApiError) || error.unauthorized) throw error;
          return create({ ...position, lineRange: undefined });
        });
    }

    const sent = await this.deliver({ mergeRequest: session.label, kind, target, text }, request);
    if (!sent) return;
    if (!discussionId) thread.dispose();
    await this.reload();
  }

  /** Sends with the journal around it; on failure the text stays in the comment box and in the journal. */
  private async deliver(
    entry: Parameters<ReviewJournal['record']>[0],
    request: () => Promise<void>,
  ): Promise<boolean> {
    const done = await this.journal.record(entry);
    try {
      await request();
      await done('sent');
      vscode.window.setStatusBarMessage(
        entry.kind === 'publish'
          ? t('Kleio: the comment is published')
          : t('Kleio: the draft is saved in GitLab'),
        3000,
      );
      return true;
    } catch (error) {
      await done({ failed: message(error) });
      const retry = t('Retry');
      const journal = t('Journal');
      const choice = await vscode.window.showErrorMessage(
        t('The comment was not sent: {0}. Its text is saved in the review journal.', message(error)),
        retry,
        journal,
      );
      if (choice === retry) return this.deliver(entry, request);
      if (choice === journal) await this.journal.open();
      return false;
    }
  }

  /**
   * The diff shown is told by its tab, whichever way it was opened: the changes since the last review go
   * through their own comments; the merge request goes on to the outdated ones, each in its version.
   */
  private async moveToComment(direction: 1 | -1): Promise<void> {
    const session = this.session;
    if (!session) return;
    const interdiffs = session.interdiffSets;
    const versions = (
      await Promise.all([...session.outdated.values()].map((anchor) => session.versionOf(anchor)))
    ).filter((set, i, all): set is ChangeSet => !!set && all.indexOf(set) === i);
    const shown = shownSet(this.navigator, [session.changeSet, ...interdiffs, ...versions]);
    const chain = shown && interdiffs.includes(shown) ? [shown] : [session.changeSet, ...versions];
    await moveToComment(this.navigator, this.board.all, chain, shown, direction);
  }

  private async resolve(thread: vscode.CommentThread, resolved: boolean): Promise<void> {
    const session = this.session;
    const ref = this.board.of(thread)?.ref;
    if (!session || ref?.kind !== 'discussion') return;
    await session.api.resolve(session.iid, ref.id, resolved);
    await this.reload();
  }

  /** Saves the edited text of your note or draft on GitLab. */
  private async saveComment(comment: ReviewComment): Promise<void> {
    const session = this.session;
    if (!session) return;
    const text = comment.edited;
    if (!text) return;
    if (text === comment.text.trim()) return comment.cancelEditing();
    const ref = comment.note.ref;
    try {
      if (ref.kind === 'draft') await session.api.updateDraftNote(session.iid, ref.id, text);
      else await session.api.updateNote(session.iid, ref.discussionId, ref.id, text);
    } catch (error) {
      void vscode.window.showErrorMessage(t('Kleio: the comment is not saved: {0}', message(error)));
      return;
    }
    vscode.window.setStatusBarMessage(t('Kleio: the comment is saved'), 3000);
    await this.reload();
  }

  private async deleteComment(comment: ReviewComment): Promise<void> {
    const session = this.session;
    const ref = comment.note.ref;
    if (!session || ref.kind !== 'note') return;
    const ok = await vscode.window.showWarningMessage(
      t('Delete your comment from GitLab?'),
      { modal: true, detail: comment.text.slice(0, 200) },
      t('Delete'),
    );
    if (!ok) return;
    try {
      await session.api.deleteNote(session.iid, ref.discussionId, ref.id);
    } catch (error) {
      void vscode.window.showErrorMessage(t('Kleio: the comment is not deleted: {0}', message(error)));
      return;
    }
    await this.reload();
  }

  private async deleteDraft(comment: ReviewComment): Promise<void> {
    const session = this.session;
    const ref = comment.note.ref;
    if (!session || ref.kind !== 'draft') return;
    await session.api.deleteDraftNote(session.iid, ref.id);
    await this.reload();
  }

  private async publishDrafts(): Promise<void> {
    const session = this.session;
    if (session) await this.publishDraftsOf(session.repository, session.iid);
  }

  /** Ends the review; `forget` is false when only the window closes, so that it comes back after a reload. */
  private end(forget = true): void {
    this.board.clear();
    this.session = undefined;
    this.newer.update();
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
    if (forget) void this.workspaceState?.update(ACTIVE_KEY, undefined);
  }

  private async label(repository: Repository, iid: number): Promise<string> {
    const remote = (await this.hosting.known(repository))?.links?.remote;
    return remote ? `${remote.host}/${remote.project}!${iid}` : `!${iid}`;
  }

  dispose(): void {
    this.end(false);
    for (const d of this.disposables) d.dispose();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
