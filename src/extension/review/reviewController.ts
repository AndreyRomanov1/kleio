import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../../shared/model';
import type { ChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import { revisionUri, workingFileUri } from '../content/revisionUri';
import type { Hunk } from '../git/parse';
import type { Repository } from '../git/repository';
import type { DiffPosition, DiffRefs, Discussion, DraftNote, GitLabApi, Note } from '../hosting/gitlabApi';
import type { HostingService } from '../hosting/hostingService';
import { linePair, type Side } from './positions';
import type { ReviewJournal } from './reviewJournal';

const CONTROLLER_ID = 'kleio.review';
const CONTEXT_KEY = 'kleio.reviewActive';

interface ReviewFile {
  change: FileChange;
  left?: vscode.Uri;
  right?: vscode.Uri;
  hunks?: Promise<Hunk[]>;
}

interface Session {
  repository: Repository;
  api: GitLabApi;
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
}

class ReviewComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  body: vscode.MarkdownString;
  author: vscode.CommentAuthorInformation;
  label?: string;
  contextValue: string;

  constructor(
    text: string,
    authorName: string,
    readonly draftId?: number,
    createdAt?: string,
  ) {
    this.body = new vscode.MarkdownString(text);
    this.author = { name: authorName };
    this.label = draftId !== undefined ? 'черновик' : createdAt ? formatTime(createdAt) : undefined;
    this.contextValue = draftId !== undefined ? 'draft' : 'note';
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
  ) {
    this.comments = vscode.comments.createCommentController(CONTROLLER_ID, 'Ревью MR');
    this.comments.options = { placeHolder: 'Комментарий к строке', prompt: 'Комментарий к MR' };
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
      vscode.commands.registerCommand('kleio.review.publishDrafts', () => this.publishDrafts()),
      vscode.commands.registerCommand('kleio.review.refresh', () => this.reload()),
      vscode.commands.registerCommand('kleio.review.end', () => this.end()),
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
    if (this.session?.iid !== iid || this.session.repository !== repository) {
      const session = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Kleio: ревью MR !${iid}` },
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
      void vscode.window.showInformationMessage(`В MR !${iid} нет изменений.`);
      return;
    }
    const index = filePath
      ? session.changeSet.files.findIndex((f) => f.path === filePath || f.oldPath === filePath)
      : 0;
    await this.navigator.open(session.changeSet, Math.max(0, index), 'first', {
      line: line === undefined ? undefined : line - 1,
    });
  }

  /** Publishes or saves a comment typed outside the code, e.g. a general comment from the merge request card. */
  async postGeneral(
    repository: Repository,
    iid: number,
    text: string,
    kind: 'publish' | 'draft',
  ): Promise<boolean> {
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
    vscode.window.setStatusBarMessage(`Kleio: черновики MR !${iid} опубликованы`, 4000);
    if (this.session?.iid === iid) await this.reload();
  }

  private async createSession(repository: Repository, iid: number): Promise<Session | undefined> {
    const api = await this.hosting.gitlab(repository, true);
    if (!api) {
      void vscode.window.showWarningMessage('Для ревью нужен доступ к GitLab.');
      return undefined;
    }
    const details = await api.mergeRequest(iid);
    const refs = details.diffRefs;
    if (!refs) {
      void vscode.window.showWarningMessage(`GitLab не отдал версии diff для MR !${iid}.`);
      return undefined;
    }
    const hosting = await this.hosting.known(repository);
    const remote = hosting?.remoteName ?? 'origin';
    if (!(await this.ensureCommits(repository, remote, iid, details.targetBranch, refs))) {
      void vscode.window.showErrorMessage(`Не удалось получить коммиты MR !${iid} из ${remote}.`);
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
    return {
      repository,
      api,
      iid,
      label: await this.label(repository, iid),
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
      void vscode.window.showErrorMessage(`Kleio: обсуждения MR не загрузились: ${message(error)}`);
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
        ...notes.map((n) => new ReviewComment(n.body, n.author.name, undefined, n.createdAt)),
        ...(draftReplies.get(discussion.id) ?? []).map((d) => new ReviewComment(d.body, 'Вы', d.id)),
      ];
      const thread = this.comments.createCommentThread(place.uri, place.range, comments);
      this.decorate(thread, first);
      session.discussions.set(thread, discussion.id);
      session.threads.push(thread);
    }
    for (const draft of drafts) {
      if (draft.discussionId || !draft.position) continue;
      const place = this.placeOf(session, draft.position);
      if (!place) continue;
      const thread = this.comments.createCommentThread(place.uri, place.range, [
        new ReviewComment(draft.body, 'Вы', draft.id),
      ]);
      thread.label = 'Черновик';
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
    return uri ? { uri, range: new vscode.Range(line - 1, 0, line - 1, 0) } : undefined;
  }

  private decorate(thread: vscode.CommentThread, first: Note): void {
    thread.canReply = true;
    if (first.resolvable) {
      thread.state = first.resolved
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
      thread.contextValue = first.resolved ? 'resolved' : 'unresolved';
      thread.label = first.resolved ? 'Решено' : undefined;
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
    const discussionId = session.discussions.get(thread);

    let target: string;
    let request: () => Promise<void>;
    if (discussionId) {
      target = `ответ в обсуждение ${discussionId}`;
      request = () =>
        kind === 'publish'
          ? session.api.reply(session.iid, discussionId, text)
          : session.api.createDraftNote(session.iid, text, { discussionId });
    } else {
      const placed = session.documents.get(thread.uri.toString());
      if (!placed || !thread.range) return;
      const line = thread.range.end.line + 1;
      const { file, side } = placed;
      file.hunks ??= session.repository.hunks(session.refs.baseSha, session.refs.headSha, file.change);
      const position: DiffPosition = {
        baseSha: session.refs.baseSha,
        startSha: session.refs.startSha,
        headSha: session.refs.headSha,
        oldPath: file.change.oldPath ?? file.change.path,
        newPath: file.change.path,
        ...linePair(await file.hunks, side, line),
      };
      target = `${side === 'new' ? file.change.path : position.oldPath}:${line}${side === 'old' ? ' (старая версия)' : ''}`;
      request = () =>
        kind === 'publish'
          ? session.api.createDiscussion(session.iid, text, position)
          : session.api.createDraftNote(session.iid, text, { position });
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
        entry.kind === 'publish' ? 'Kleio: комментарий опубликован' : 'Kleio: черновик сохранён в GitLab',
        3000,
      );
      return true;
    } catch (error) {
      await done({ failed: message(error) });
      const retry = 'Повторить';
      const journal = 'Журнал';
      const choice = await vscode.window.showErrorMessage(
        `Комментарий не отправлен: ${message(error)}. Текст сохранён в журнале ревью.`,
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
      vscode.window.setStatusBarMessage('Kleio: в MR нет замечаний к текущей версии', 3000);
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
        direction === 1 ? 'Kleio: это последнее замечание' : 'Kleio: это первое замечание',
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

const timeFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : timeFormat.format(date);
}
