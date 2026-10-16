import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../../shared/model';
import type { ChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import { revisionUri, workingFileUri } from '../content/revisionUri';
import type { Hunk } from '../git/parse';
import type { Repository } from '../git/repository';
import {
  GitLabApiError,
  type DiffPosition,
  type DiffRefs,
  type Discussion,
  type DraftNote,
  type GitLabApi,
  type Note,
} from '../hosting/gitlabApi';
import type { HostingService } from '../hosting/hostingService';
import { lineCounters, linePair, type Side } from './positions';
import type { ReviewJournal } from './reviewJournal';
import { t } from '../../shared/l10n';
import { displayLanguage } from '../language';

const CONTROLLER_ID = 'kleio.review';
const CONTEXT_KEY = 'kleio.reviewActive';
/** The version of each merge request reviewed last, to show what changed since then. */
const SEEN_KEY = 'kleio.review.seen';
const SEEN_LIMIT = 300;

interface ReviewFile {
  change: FileChange;
  left?: vscode.Uri;
  right?: vscode.Uri;
  hunks?: Promise<Hunk[]>;
}

interface Session {
  repository: Repository;
  api: GitLabApi;
  /** Username of the reviewer, to tell their own comments. */
  me?: string;
  /** Threads whose comment is on its way: a second Ctrl+Enter or click meanwhile would send it again. */
  sending: WeakSet<vscode.CommentThread>;
  iid: number;
  /** `host/project!iid`, for the journal. */
  label: string;
  refs: DiffRefs;
  changeSet: ChangeSet;
  files: ReviewFile[];
  /** Document URI → file and side, for placing comments. */
  documents: Map<string, { file: ReviewFile; side: Side }>;
  threads: vscode.CommentThread[];
  /** Thread → GitLab discussion. */
  discussions: WeakMap<vscode.CommentThread, string>;
  /** The version reviewed last time, when the merge request has changed since then. */
  previous?: { baseSha: string; headSha: string };
}

/** Which comment it is on GitLab: a note of a discussion, or a draft. */
type CommentSource = { draftId: number } | { discussionId: string; noteId: number; mine: boolean };

class ReviewComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  body: vscode.MarkdownString | string;
  author: vscode.CommentAuthorInformation;
  label?: string;
  contextValue: string;
  /** Set once the comment is in a thread, to redraw it when editing starts or ends. */
  thread?: vscode.CommentThread;

  constructor(
    readonly text: string,
    authorName: string,
    readonly source: CommentSource,
    createdAt?: string,
  ) {
    this.body = new vscode.MarkdownString(text);
    this.author = { name: authorName };
    const draft = 'draftId' in source;
    this.label = draft ? t('draft') : createdAt ? formatTime(createdAt) : undefined;
    // Your own notes and drafts can be edited; your own notes and drafts can be deleted.
    this.contextValue = draft ? 'draft' : source.mine ? 'mine' : 'note';
  }

  get draftId(): number | undefined {
    return 'draftId' in this.source ? this.source.draftId : undefined;
  }
}

/**
 * Reviewing a GitLab merge request in the regular diff viewer: existing discussions are shown in the code,
 * new comments are published at once or saved as GitLab drafts ("pending comments") to submit together.
 */
export class ReviewController implements vscode.Disposable {
  private session?: Session;
  private readonly comments: vscode.CommentController;
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly hosting: HostingService,
    private readonly navigator: ChangeSetNavigator,
    private readonly journal: ReviewJournal,
    private readonly state: vscode.Memento,
  ) {
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
    this.disposables = [
      this.comments,
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
        this.editComment(comment),
      ),
      vscode.commands.registerCommand('kleio.review.saveComment', (comment: ReviewComment) =>
        this.saveComment(comment),
      ),
      vscode.commands.registerCommand('kleio.review.cancelEdit', (comment: ReviewComment) =>
        this.cancelEdit(comment),
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
    ];
  }

  get activeMergeRequest(): number | undefined {
    return this.session?.iid;
  }

  /** Threads shown in the code: where they are and what they say. */
  openThreads(): { uri: string; line: number; comments: string[]; label?: string }[] {
    return (this.session?.threads ?? []).map((t) => ({
      uri: t.uri.toString(),
      line: (t.range?.start.line ?? 0) + 1,
      comments: t.comments.map((c) => (typeof c.body === 'string' ? c.body : c.body.value)),
      label: t.label,
    }));
  }

  /** Opens the merge request diff (what GitLab shows) and its discussions; `filePath` and `line` to jump to. */
  async start(repository: Repository, iid: number, filePath?: string, line?: number): Promise<void> {
    if ((await this.hosting.known(repository))?.links?.kind === 'github')
      return this.openPullRequest(repository, iid, filePath, line);
    let started = false;
    if (this.session?.iid !== iid || this.session.repository !== repository) {
      started = true;
      const session = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Kleio: review of !{0}', iid) },
        () => this.createSession(repository, iid),
      );
      if (!session) return;
      this.end();
      this.session = session;
      void vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
      await this.reload();
    }
    const session = this.session!;
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
    if (started && session.previous) this.offerSinceLastReview(session);
  }

  /**
   * The changes of a GitHub pull request in the diff viewer, as GitHub shows them: from where the branch
   * left its target. Comments in the code stay on GitHub for now.
   */
  private async openPullRequest(
    repository: Repository,
    number: number,
    filePath?: string,
    line?: number,
  ): Promise<void> {
    const github = await this.hosting.github(repository, true);
    if (!github) {
      void vscode.window.showWarningMessage(t('The review needs access to GitHub.'));
      return;
    }
    const opened = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Kleio: pull request #{0}', number) },
      async () => {
        const { card } = await github.pullRequestCard(number);
        const remote = (await this.hosting.known(repository))?.remoteName ?? 'origin';
        const has = async () =>
          !!(await repository.revParse(card.headRefOid)) && !!(await repository.revParse(card.baseRefOid));
        if (!(await has()))
          await repository.git
            .run(['fetch', remote, `refs/pull/${number}/head`, card.baseRefName], { timeoutMs: 120_000 })
            .catch(() => undefined);
        if (!(await has())) return undefined;
        const base = (await repository.git.run(['merge-base', card.baseRefOid, card.headRefOid])).trim();
        return { base, head: card.headRefOid, files: await repository.changes(base, card.headRefOid) };
      },
    );
    if (!opened) {
      void vscode.window.showErrorMessage(t('Could not fetch the commits of #{0}.', number));
      return;
    }
    if (!opened.files.length) {
      void vscode.window.showInformationMessage(t('Pull request #{0} has no changes.', number));
      return;
    }
    const index = filePath ? opened.files.findIndex((f) => f.path === filePath || f.oldPath === filePath) : 0;
    await this.navigator.open(
      { repository, title: `PR #${number}`, left: opened.base, right: opened.head, files: opened.files },
      Math.max(0, index),
      'first',
      { line: line === undefined ? undefined : line - 1 },
    );
  }

  /** Not awaited: the review is open already, the offer only narrows it down. */
  private offerSinceLastReview(session: Session): void {
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

  /**
   * The changes of the merge request since the version reviewed last time. After new commits it is the diff
   * between the two heads; after a rebase the old changes are first moved onto the new base, so that what
   * came from the target branch is not shown as the author's work.
   */
  private async sinceLastReview(): Promise<void> {
    const session = this.session;
    const previous = session?.previous;
    if (!session || !previous) {
      void vscode.window.showInformationMessage(
        t('Kleio has not seen an earlier version of this merge request.'),
      );
      return;
    }
    const { repository, refs } = session;
    if (!(await repository.revParse(previous.headSha)) || !(await repository.revParse(previous.baseSha))) {
      void vscode.window.showWarningMessage(
        t('The commits of the earlier version are not in the repository any more.'),
      );
      return;
    }
    let left = previous.headSha;
    if (!(await repository.isAncestor(previous.headSha, refs.headSha))) {
      const tree = await repository.rebasedTree(previous.baseSha, previous.headSha, refs.baseSha);
      if (tree) left = tree;
      else
        void vscode.window.showWarningMessage(
          t('The earlier version conflicts with the new base: the diff includes the changes of the rebase.'),
        );
    }
    const files = await repository.changes(left, refs.headSha);
    if (!files.length) {
      void vscode.window.showInformationMessage(
        t('!{0}: nothing has changed since the last review.', session.iid),
      );
      return;
    }
    await this.navigator.open(
      {
        repository,
        title: t('!{0} since the last review', session.iid),
        left,
        right: refs.headSha,
        files,
        rightUris: session.changeSet.rightUris,
      },
      0,
    );
  }

  /** Remembers the version under review and returns the one seen before, if it was different. */
  private async remember(
    label: string,
    refs: DiffRefs,
  ): Promise<{ baseSha: string; headSha: string } | undefined> {
    const seen = this.state.get<Record<string, { baseSha: string; headSha: string }>>(SEEN_KEY, {});
    const previous = seen[label];
    const entries = Object.entries(seen).filter(([key]) => key !== label);
    entries.push([label, { baseSha: refs.baseSha, headSha: refs.headSha }]);
    await this.state.update(SEEN_KEY, Object.fromEntries(entries.slice(-SEEN_LIMIT)));
    return previous && previous.headSha !== refs.headSha ? previous : undefined;
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

  private async createSession(repository: Repository, iid: number): Promise<Session | undefined> {
    const api = await this.hosting.gitlab(repository, true);
    if (!api) {
      void vscode.window.showWarningMessage(t('The review needs access to GitLab.'));
      return undefined;
    }
    const details = await api.mergeRequest(iid);
    const refs = details.diffRefs;
    if (!refs) {
      void vscode.window.showWarningMessage(t('GitLab returned no diff versions for !{0}.', iid));
      return undefined;
    }
    const hosting = await this.hosting.known(repository);
    const remote = hosting?.remoteName ?? 'origin';
    if (!(await this.ensureCommits(repository, remote, iid, details.targetBranch, refs))) {
      void vscode.window.showErrorMessage(t('Could not fetch the commits of !{0} from {1}.', iid, remote));
      return undefined;
    }

    const changes = await repository.changes(refs.baseSha, refs.headSha);
    // One call tells which files on disk are the same as in the merge request: those open as real files.
    const differing = new Set(
      (await repository.git.run(['diff', '--name-only', '-z', refs.headSha, '--']))
        .split('\0')
        .filter(Boolean),
    );
    const files: ReviewFile[] = changes.map((change) => {
      const onDisk = !differing.has(change.path) && existsSync(path.join(repository.root, change.path));
      return {
        change,
        left:
          change.status === 'A'
            ? undefined
            : revisionUri(repository.root, refs.baseSha, change.oldPath ?? change.path),
        right:
          change.status === 'D'
            ? undefined
            : onDisk
              ? workingFileUri(repository.root, change.path)
              : revisionUri(repository.root, refs.headSha, change.path),
      };
    });
    const documents = new Map<string, { file: ReviewFile; side: Side }>();
    for (const file of files) {
      if (file.left) documents.set(file.left.toString(), { file, side: 'old' });
      if (file.right) documents.set(file.right.toString(), { file, side: 'new' });
    }
    const rightUris = new Map(files.filter((f) => f.right).map((f) => [f.change.path, f.right!] as const));
    const label = await this.label(repository, iid);
    return {
      repository,
      api,
      me: await api
        .currentUser()
        .then((p) => p.username)
        .catch(() => undefined),
      sending: new WeakSet(),
      iid,
      label,
      previous: await this.remember(label, refs),
      refs,
      changeSet: {
        repository,
        title: `MR !${iid}`,
        left: refs.baseSha,
        right: refs.headSha,
        files: changes,
        rightUris,
      },
      files,
      documents,
      threads: [],
      discussions: new WeakMap(),
    };
  }

  /** Commits of the merge request may be missing locally: GitLab keeps them under `refs/merge-requests`. */
  private async ensureCommits(
    repository: Repository,
    remote: string,
    iid: number,
    targetBranch: string,
    refs: DiffRefs,
  ): Promise<boolean> {
    const missing = async () =>
      !(await repository.revParse(refs.headSha)) || !(await repository.revParse(refs.baseSha));
    if (!(await missing())) return true;
    await repository.git
      .run(['fetch', remote, `refs/merge-requests/${iid}/head`, targetBranch], { timeoutMs: 120_000 })
      .catch(() => undefined);
    return !(await missing());
  }

  private async reload(): Promise<void> {
    const session = this.session;
    if (!session) return;
    let discussions: Discussion[];
    let drafts: DraftNote[];
    try {
      [discussions, drafts] = await Promise.all([
        session.api.discussions(session.iid),
        session.api.draftNotes(session.iid),
      ]);
    } catch (error) {
      void vscode.window.showErrorMessage(t('Kleio: the discussions did not load: {0}', message(error)));
      return;
    }
    if (session !== this.session) return;
    for (const thread of session.threads) thread.dispose();
    session.threads = [];

    const draftReplies = new Map<string, DraftNote[]>();
    for (const draft of drafts) {
      if (draft.discussionId)
        draftReplies.set(draft.discussionId, [...(draftReplies.get(draft.discussionId) ?? []), draft]);
    }
    for (const discussion of discussions) {
      const notes = discussion.notes.filter((n) => !n.system);
      const first = notes[0];
      if (!first?.position || first.position.headSha !== session.refs.headSha) continue;
      const place = this.placeOf(session, first.position);
      if (!place) continue;
      const comments = [
        ...notes.map(
          (n) =>
            new ReviewComment(
              n.body,
              n.author.name,
              { discussionId: discussion.id, noteId: n.id, mine: n.author.username === session.me },
              n.createdAt,
            ),
        ),
        ...(draftReplies.get(discussion.id) ?? []).map(
          (d) => new ReviewComment(d.body, t('You'), { draftId: d.id }),
        ),
      ];
      const thread = this.comments.createCommentThread(place.uri, place.range, comments);
      for (const comment of comments) comment.thread = thread;
      this.decorate(thread, first);
      session.discussions.set(thread, discussion.id);
      session.threads.push(thread);
    }
    for (const draft of drafts) {
      if (draft.discussionId || !draft.position) continue;
      const place = this.placeOf(session, draft.position);
      if (!place) continue;
      const comment = new ReviewComment(draft.body, t('You'), { draftId: draft.id });
      const thread = this.comments.createCommentThread(place.uri, place.range, [comment]);
      comment.thread = thread;
      thread.label = t('Draft');
      thread.contextValue = 'draft';
      thread.canReply = false;
      session.threads.push(thread);
    }
  }

  private placeOf(
    session: Session,
    position: DiffPosition,
  ): { uri: vscode.Uri; range: vscode.Range } | undefined {
    const file = session.files.find(
      (f) => f.change.path === position.newPath || (f.change.oldPath ?? f.change.path) === position.oldPath,
    );
    if (!file) return undefined;
    const onNew = position.newLine !== undefined;
    const uri = onNew ? file.right : file.left;
    const line = (onNew ? position.newLine : position.oldLine) ?? 1;
    const start = position.lineRange?.start;
    const first = (onNew ? start?.newLine : start?.oldLine) ?? line;
    return uri ? { uri, range: new vscode.Range(Math.min(first, line) - 1, 0, line - 1, 0) } : undefined;
  }

  private decorate(thread: vscode.CommentThread, first: Note): void {
    thread.canReply = true;
    if (first.resolvable) {
      thread.state = first.resolved
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
      thread.contextValue = first.resolved ? 'resolved' : 'unresolved';
      thread.label = first.resolved ? t('Resolved') : undefined;
      thread.collapsibleState = first.resolved
        ? vscode.CommentThreadCollapsibleState.Collapsed
        : vscode.CommentThreadCollapsibleState.Expanded;
    } else {
      thread.contextValue = 'plain';
    }
  }

  private async send(reply: vscode.CommentReply, kind: 'publish' | 'draft'): Promise<void> {
    const session = this.session;
    const text = reply.text.trim();
    if (!session || !text) return;
    const thread = reply.thread;
    if (session.sending.has(thread)) return;
    session.sending.add(thread);
    const label = thread.label;
    thread.label = t('Sending…');
    try {
      await this.sendTo(session, thread, text, kind);
    } finally {
      session.sending.delete(thread);
      thread.label = label;
    }
  }

  private async sendTo(
    session: Session,
    thread: vscode.CommentThread,
    text: string,
    kind: 'publish' | 'draft',
  ): Promise<void> {
    const discussionId = session.discussions.get(thread);

    let target: string;
    let request: () => Promise<void>;
    if (discussionId) {
      target = t('reply in discussion {0}', discussionId);
      request = () =>
        kind === 'publish'
          ? session.api.reply(session.iid, discussionId, text)
          : session.api.createDraftNote(session.iid, text, { discussionId });
    } else {
      const placed = session.documents.get(thread.uri.toString());
      if (!placed || !thread.range) return;
      const line = thread.range.end.line + 1;
      const first = thread.range.start.line + 1;
      const { file, side } = placed;
      file.hunks ??= session.repository.hunks(session.refs.baseSha, session.refs.headSha, file.change);
      const hunks = await file.hunks;
      const end = linePair(hunks, side, line);
      const position: DiffPosition = {
        baseSha: session.refs.baseSha,
        startSha: session.refs.startSha,
        headSha: session.refs.headSha,
        oldPath: file.change.oldPath ?? file.change.path,
        newPath: file.change.path,
        ...end,
        lineRange:
          first < line
            ? {
                start: { ...linePair(hunks, side, first), counters: lineCounters(hunks, side, first) },
                end: { ...end, counters: lineCounters(hunks, side, line) },
              }
            : undefined,
      };
      const lines = first < line ? `${first}–${line}` : `${line}`;
      target = `${side === 'new' ? file.change.path : position.oldPath}:${lines}${side === 'old' ? t(' (old version)') : ''}`;
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

  /** Jumps to the next or previous review thread in the order of files of the merge request, then lines. */
  private async moveToComment(direction: 1 | -1): Promise<void> {
    const session = this.session;
    if (!session) return;
    const order = (uri: vscode.Uri) => {
      const placed = session.documents.get(uri.toString());
      return placed ? session.files.indexOf(placed.file) : -1;
    };
    const targets = session.threads
      .filter((t) => t.range)
      .map((thread) => ({ thread, file: order(thread.uri), line: thread.range!.start.line }))
      .filter((t) => t.file >= 0)
      .sort((a, b) => a.file - b.file || a.line - b.line);
    if (targets.length === 0) {
      vscode.window.setStatusBarMessage(
        t('Kleio: the merge request has no comments on the current version'),
        3000,
      );
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const file = editor ? order(editor.document.uri) : -1;
    const line = editor?.selection.active.line ?? -1;
    const after = (t: (typeof targets)[number]) => t.file > file || (t.file === file && t.line > line);
    const before = (t: (typeof targets)[number]) => t.file < file || (t.file === file && t.line < line);
    const target = direction === 1 ? targets.find(after) : [...targets].reverse().find(before);
    if (!target) {
      vscode.window.setStatusBarMessage(
        direction === 1 ? t('Kleio: this is the last comment') : t('Kleio: this is the first comment'),
        3000,
      );
      return;
    }
    target.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const visible = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === target.thread.uri.toString(),
    );
    if (visible && target.file === file) {
      const position = new vscode.Position(target.line, 0);
      visible.selection = new vscode.Selection(position, position);
      visible.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      return;
    }
    const placed = session.documents.get(target.thread.uri.toString())!;
    const index = session.changeSet.files.findIndex((f) => f.path === placed.file.change.path);
    // The diff reveals lines of its new side; a thread on a removed line is shown at its place on the old side.
    await this.navigator.open(session.changeSet, index, 'first', {
      line: placed.side === 'new' ? target.line : undefined,
    });
    if (placed.side === 'old') {
      const left = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === target.thread.uri.toString(),
      );
      const position = new vscode.Position(target.line, 0);
      if (left) left.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
  }

  private async resolve(thread: vscode.CommentThread, resolved: boolean): Promise<void> {
    const session = this.session;
    const id = session?.discussions.get(thread);
    if (!session || !id) return;
    await session.api.resolve(session.iid, id, resolved);
    await this.reload();
  }

  private editComment(comment: ReviewComment): void {
    comment.mode = vscode.CommentMode.Editing;
    this.redraw(comment);
  }

  private cancelEdit(comment: ReviewComment): void {
    comment.mode = vscode.CommentMode.Preview;
    comment.body = new vscode.MarkdownString(comment.text);
    this.redraw(comment);
  }

  /** Saves the edited text of your note or draft on GitLab. */
  private async saveComment(comment: ReviewComment): Promise<void> {
    const session = this.session;
    if (!session) return;
    const text = (typeof comment.body === 'string' ? comment.body : comment.body.value).trim();
    if (!text) return;
    if (text === comment.text.trim()) return this.cancelEdit(comment);
    const source = comment.source;
    try {
      if ('draftId' in source) await session.api.updateDraftNote(session.iid, source.draftId, text);
      else await session.api.updateNote(session.iid, source.discussionId, source.noteId, text);
    } catch (error) {
      void vscode.window.showErrorMessage(t('Kleio: the comment is not saved: {0}', message(error)));
      return;
    }
    vscode.window.setStatusBarMessage(t('Kleio: the comment is saved'), 3000);
    await this.reload();
  }

  private async deleteComment(comment: ReviewComment): Promise<void> {
    const session = this.session;
    const source = comment.source;
    if (!session || 'draftId' in source) return;
    const ok = await vscode.window.showWarningMessage(
      t('Delete your comment from GitLab?'),
      { modal: true, detail: comment.text.slice(0, 200) },
      t('Delete'),
    );
    if (!ok) return;
    try {
      await session.api.deleteNote(session.iid, source.discussionId, source.noteId);
    } catch (error) {
      void vscode.window.showErrorMessage(t('Kleio: the comment is not deleted: {0}', message(error)));
      return;
    }
    await this.reload();
  }

  private redraw(comment: ReviewComment): void {
    const thread = comment.thread;
    if (thread) thread.comments = thread.comments.map((c) => c);
  }

  private async deleteDraft(comment: ReviewComment): Promise<void> {
    const session = this.session;
    if (!session || comment.draftId === undefined) return;
    await session.api.deleteDraftNote(session.iid, comment.draftId);
    await this.reload();
  }

  private async publishDrafts(): Promise<void> {
    const session = this.session;
    if (session) await this.publishDraftsOf(session.repository, session.iid);
  }

  private end(): void {
    for (const thread of this.session?.threads ?? []) thread.dispose();
    this.session = undefined;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
  }

  private async label(repository: Repository, iid: number): Promise<string> {
    const remote = (await this.hosting.known(repository))?.links?.remote;
    return remote ? `${remote.host}/${remote.project}!${iid}` : `!${iid}`;
  }

  dispose(): void {
    this.end();
    for (const d of this.disposables) d.dispose();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(displayLanguage(), { dateStyle: 'short', timeStyle: 'short' }).format(date);
}
