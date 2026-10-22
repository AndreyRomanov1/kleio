import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../../shared/model';
import type { ChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import { revisionUri, workingFileUri } from '../content/revisionUri';
import type { Hunk } from '../git/parse';
import type { Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
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
import { followLine, lineCounters, linePair, type Side } from './positions';
import type { ReviewJournal } from './reviewJournal';
import { t } from '../../shared/l10n';
import { displayLanguage } from '../language';

const CONTROLLER_ID = 'kleio.review';
const CONTEXT_KEY = 'kleio.reviewActive';
/** The version of each merge request reviewed last, to show what changed since then. */
const SEEN_KEY = 'kleio.review.seen';
const SEEN_LIMIT = 300;
const SEEN_VERSIONS = 50;
/** New comments and versions are looked for at most this often without a click. */
const REFRESH_MS = 30_000;
/** The review open in this workspace, to bring it back after a reload of the window. */
const ACTIVE_KEY = 'kleio.review.active';

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
  /** Diffs of earlier versions of the merge request by `base..head`, for its outdated discussions. */
  versions: Map<string, Promise<ChangeSet | undefined>>;
  /** The diffs worked out for the review besides the merge request: since the last review, earlier versions. */
  loadedSets: ChangeSet[];
  /** Outdated discussions by id: where they were made. */
  outdated: Map<string, DiffPosition>;
  /** The version looked at last before this one, to show what changed since then. */
  previous?: Version;
  /** The merge request has a version you have not looked at yet. */
  changed: boolean;
  /** Diffs between two versions by `from..to`, each worked out once. */
  interdiffs: Map<string, Promise<Interdiff | undefined>>;
  loadedInterdiffs: Interdiff[];
  /** Taken up by itself as the merge request of the current branch, not opened by hand. */
  auto: boolean;
}

interface Version {
  baseSha: string;
  headSha: string;
}

/**
 * What changed from one version of a merge request to another, as GitLab compares versions: after a rebase the
 * earlier changes are first moved onto the new base, so that what came from the target branch is not shown
 * as the author's work.
 */
interface Interdiff {
  set: ChangeSet;
  from: Version;
  left: string;
  files: FileChange[];
  /** The earlier version did not move onto the new base, and the diff has the changes of the rebase. */
  conflicted: boolean;
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
  private following = false;
  private reloadedAt = 0;
  private readonly comments: vscode.CommentController;
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly hosting: HostingService,
    private readonly navigator: ChangeSetNavigator,
    private readonly journal: ReviewJournal,
    private readonly state: vscode.Memento,
    private readonly workspaceState?: vscode.Memento,
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
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.refreshQuietly();
      }),
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
      return this.openPullRequest(repository, iid, filePath, line);
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
  private async looked(session: Session): Promise<void> {
    const isNew = this.seenOf(session.label).at(-1)?.headSha !== session.refs.headSha;
    await this.markSeen(session.label, current(session));
    if (isNew && session.previous) this.offerSinceLastReview(session);
  }

  /** A merge request opened by hand: its session, taken up or made, with the comments in the code. */
  private async ensureSession(repository: Repository, iid: number): Promise<boolean> {
    const existing = this.session;
    if (existing?.iid === iid && existing.repository === repository) {
      existing.auto = false;
      await this.renewIfUpdated(existing, false);
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

  /** The changes of the merge request since the version looked at last time. */
  private async sinceLastReview(): Promise<void> {
    const session = this.session;
    if (!session?.previous) {
      void vscode.window.showInformationMessage(
        t('Kleio has not seen an earlier version of this merge request.'),
      );
      return;
    }
    await this.openInterdiff(session, session.previous, current(session));
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
      const set = await this.versionOf(session, to);
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

  private async openInterdiff(session: Session, from: Version, to: Version): Promise<void> {
    const interdiff = await this.interdiffOf(session, from, to);
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
    if (to.headSha === session.refs.headSha) await this.markSeen(session.label, to);
  }

  private sinceOf(session: Session): Promise<Interdiff | undefined> | undefined {
    return session.previous && this.interdiffOf(session, session.previous, current(session));
  }

  private interdiffOf(session: Session, from: Version, to: Version): Promise<Interdiff | undefined> {
    const key = `${from.headSha}..${to.headSha}`;
    let interdiff = session.interdiffs.get(key);
    if (!interdiff) {
      interdiff = this.workOutInterdiff(session, from, to).catch(() => undefined);
      session.interdiffs.set(key, interdiff);
    }
    return interdiff;
  }

  private async workOutInterdiff(
    session: Session,
    from: Version,
    to: Version,
  ): Promise<Interdiff | undefined> {
    const { repository } = session;
    if (!(await this.ensureVersionCommits(session, [from.baseSha, from.headSha, to.baseSha, to.headSha])))
      return undefined;
    let left = from.headSha;
    let conflicted = false;
    if (!(await repository.isAncestor(from.headSha, to.headSha))) {
      const tree = await repository.rebasedTree(from.baseSha, from.headSha, to.baseSha);
      if (tree) left = tree;
      else conflicted = true;
    }
    const files = await repository.changes(left, to.headSha);
    const latest = to.headSha === session.refs.headSha;
    const set: ChangeSet = {
      repository,
      title:
        latest && from.headSha === session.previous?.headSha
          ? t('!{0} since the last review', session.iid)
          : t('!{0}: {1} → {2}', session.iid, from.headSha.slice(0, 8), to.headSha.slice(0, 8)),
      left,
      right: to.headSha,
      files,
      rightUris: latest ? session.changeSet.rightUris : undefined,
    };
    const interdiff = { set, from, left, files, conflicted };
    session.loadedSets.push(set);
    session.loadedInterdiffs.push(interdiff);
    return interdiff;
  }

  /** Commits of earlier versions may be gone from the branch after a force push; GitLab keeps them. */
  private async ensureVersionCommits(session: Session, shas: string[]): Promise<boolean> {
    const { repository } = session;
    const missing = async () =>
      (await Promise.all(shas.map((sha) => repository.revParse(sha)))).some((s) => !s);
    if (!(await missing())) return true;
    const remote = (await this.hosting.known(repository))?.remoteName ?? 'origin';
    await repository.git
      .run(['fetch', remote, ...new Set(shas)], { timeoutMs: 120_000 })
      .catch(() => undefined);
    return !(await missing());
  }

  /**
   * The diff of an earlier version of the merge request, as GitLab showed it then: outdated discussions are
   * in it at the lines they were made on.
   */
  private versionOf(session: Session, version: Version): Promise<ChangeSet | undefined> {
    const key = `${version.baseSha}..${version.headSha}`;
    let set = session.versions.get(key);
    if (!set) {
      set = this.workOutVersion(session, version).catch(() => undefined);
      session.versions.set(key, set);
    }
    return set;
  }

  private async workOutVersion(session: Session, version: Version): Promise<ChangeSet | undefined> {
    const { repository } = session;
    if (!(await this.ensureVersionCommits(session, [version.baseSha, version.headSha]))) return undefined;
    const set: ChangeSet = {
      repository,
      title: t('!{0}, version {1}', session.iid, version.headSha.slice(0, 8)),
      left: version.baseSha,
      right: version.headSha,
      files: await repository.changes(version.baseSha, version.headSha),
    };
    session.loadedSets.push(set);
    return set;
  }

  /** Opens an outdated discussion in the version of the merge request it was made on. */
  private async openOutdated(session: Session, position: DiffPosition): Promise<boolean> {
    const set = await this.versionOf(session, position);
    const index =
      set?.files.findIndex((f) => f.path === position.newPath || f.oldPath === position.oldPath) ?? -1;
    if (!set || index < 0) {
      void vscode.window.showWarningMessage(
        t('The commits of the earlier version are not in the repository any more.'),
      );
      return false;
    }
    const onNew = position.newLine !== undefined;
    const line = (onNew ? position.newLine : position.oldLine)! - 1;
    await this.navigator.open(set, index, 'first', { line: onNew ? line : undefined });
    if (!onNew) revealOld(set, index, line);
    return true;
  }

  /** The versions of each merge request you looked at, oldest first. */
  private seenOf(label: string): Version[] {
    type Old = Version & { before?: Version };
    const stored = this.state.get<Record<string, Version[] | Old>>(SEEN_KEY, {})[label];
    if (!stored) return [];
    if (Array.isArray(stored)) return stored;
    return [...(stored.before ? [stored.before] : []), { baseSha: stored.baseSha, headSha: stored.headSha }];
  }

  /** The version looked at last before the one under review, and whether that one is new to you. */
  private seenState(label: string, refs: DiffRefs): { previous?: Version; changed: boolean } {
    const seen = this.seenOf(label);
    const previous = [...seen].reverse().find((v) => v.headSha !== refs.headSha);
    return { previous, changed: seen.length > 0 && seen.at(-1)!.headSha !== refs.headSha };
  }

  /** Heads of the versions of a merge request you looked at, for its card. */
  async seenHeads(repository: Repository, iid: number): Promise<string[]> {
    return this.seenOf(await this.label(repository, iid)).map((v) => v.headSha);
  }

  /** Remembers that you looked at a version: the diff of the merge request was shown, not just its comments. */
  private async markSeen(label: string, version: Version): Promise<void> {
    const seen = this.seenOf(label);
    if (seen.at(-1)?.headSha === version.headSha) return;
    const versions = [...seen.filter((v) => v.headSha !== version.headSha), version].slice(-SEEN_VERSIONS);
    const all = this.state.get<Record<string, unknown>>(SEEN_KEY, {});
    const entries = Object.entries(all).filter(([key]) => key !== label);
    entries.push([label, versions]);
    await this.state.update(SEEN_KEY, Object.fromEntries(entries.slice(-SEEN_LIMIT)));
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

  private begin(session: Session): void {
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
    const since = await this.sinceOf(session);
    await this.reload();
    await this.navigator.restore(repositories, [session.changeSet, ...(since ? [since.set] : [])]);
  }

  private async createSession(
    repository: Repository,
    iid: number,
    quiet = false,
  ): Promise<Session | undefined> {
    const api = await this.hosting.gitlab(repository, !quiet);
    if (!api) {
      if (!quiet) void vscode.window.showWarningMessage(t('The review needs access to GitLab.'));
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
      versions: new Map(),
      loadedSets: [],
      outdated: new Map(),
      iid,
      label,
      ...this.seenState(label, refs),
      interdiffs: new Map(),
      loadedInterdiffs: [],
      auto: false,
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
    this.reloadedAt = Date.now();
    if (await this.renewIfUpdated(session, true)) return;
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
    // An outdated discussion stands in the version it was made on, and on the left of each comparison from
    // that version: GitLab keeps a discussion on the version after which its line changed.
    const earlier = new Map<string, Place[]>();
    for (const discussion of discussions) {
      const position = discussion.notes.find((n) => !n.system)?.position;
      if (!position || position.headSha === session.refs.headSha) continue;
      for (const interdiff of session.loadedInterdiffs) {
        if (interdiff.from.headSha !== position.headSha) continue;
        const place = await this.earlierPlaceOf(session, position, interdiff);
        if (place) earlier.set(discussion.id, [...(earlier.get(discussion.id) ?? []), place]);
      }
    }
    if (session !== this.session) return;
    session.outdated.clear();
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
      if (!first?.position) continue;
      const outdated = first.position.headSha !== session.refs.headSha;
      const places: Place[] = [];
      if (outdated) {
        session.outdated.set(discussion.id, first.position);
        const own = versionPlaceOf(session.repository.root, first.position);
        places.push(own);
        for (const place of earlier.get(discussion.id) ?? [])
          if (!places.some((p) => samePlace(p, place))) places.push(place);
      } else {
        const place = this.placeOf(session, first.position);
        if (place) places.push(place);
      }
      for (const place of places)
        this.addThread(session, discussion.id, place, notes, draftReplies, outdated);
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

  private addThread(
    session: Session,
    discussionId: string,
    place: Place,
    notes: Note[],
    draftReplies: Map<string, DraftNote[]>,
    outdated: boolean,
  ): void {
    const comments = [
      ...notes.map(
        (n) =>
          new ReviewComment(
            n.body,
            n.author.name,
            { discussionId, noteId: n.id, mine: n.author.username === session.me },
            n.createdAt,
          ),
      ),
      ...(draftReplies.get(discussionId) ?? []).map(
        (d) => new ReviewComment(d.body, t('You'), { draftId: d.id }),
      ),
    ];
    const thread = this.comments.createCommentThread(place.uri, place.range, comments);
    for (const comment of comments) comment.thread = thread;
    this.decorate(thread, notes[0]);
    if (outdated && !notes[0].resolved) thread.label = t('On the earlier version');
    session.discussions.set(thread, discussionId);
    session.threads.push(thread);
  }

  /**
   * GitLab reviews the latest version of a merge request, and comments made on an earlier one are moved onto it.
   * After a push the review moves on to the new version as well, the file shown stays shown, and what changed
   * since the version reviewed so far is offered.
   */
  private async renewIfUpdated(session: Session, reopen: boolean): Promise<boolean> {
    const head = await session.api
      .mergeRequest(session.iid)
      .then((details) => details.diffRefs?.headSha)
      .catch(() => undefined);
    if (!head || head === session.refs.headSha || session !== this.session) return false;
    const renewed = await this.createSession(session.repository, session.iid, true).catch(() => undefined);
    if (!renewed || session !== this.session) return false;
    const shown = this.navigator.shownFile;
    const path =
      shown && this.ownSets(session).includes(shown.changeSet)
        ? shown.changeSet.files[shown.index]?.path
        : undefined;
    const line = vscode.window.activeTextEditor?.selection.active.line;
    this.end(false);
    this.begin(renewed);
    await this.reload();
    renewed.auto = session.auto;
    if (reopen && path !== undefined) {
      const index = renewed.changeSet.files.findIndex((f) => f.path === path);
      if (index >= 0) {
        await this.navigator.open(renewed.changeSet, index, 'first', { line });
        await this.looked(renewed);
      }
    }
    return true;
  }

  /** The diffs of a review: the merge request, what changed since the last review, its earlier versions. */
  private ownSets(session: Session): ChangeSet[] {
    return [session.changeSet, ...session.loadedSets];
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

  /**
   * A discussion of an earlier version goes on the left side of a comparison from that version, so that the
   * comment stands next to how it was dealt with; after a rebase its line is followed onto the new base.
   */
  private async earlierPlaceOf(
    session: Session,
    position: DiffPosition,
    since: Interdiff,
  ): Promise<Place | undefined> {
    if (position.newLine === undefined) return undefined;
    const change = since?.files.find((f) => (f.oldPath ?? f.path) === position.newPath);
    if (!change || change.status === 'A') return undefined;
    const hunks =
      position.headSha === since.left
        ? []
        : await session.repository
            .hunks(position.headSha, since.left, { status: 'M', path: position.newPath })
            .catch(() => undefined);
    const line = hunks && followLine(hunks, position.newLine);
    if (!line) return undefined;
    const start = position.lineRange?.start.newLine;
    const first = (start !== undefined && followLine(hunks, start)) || line;
    return {
      uri: revisionUri(session.repository.root, since.left, change.oldPath ?? change.path),
      range: new vscode.Range(Math.min(first, line) - 1, 0, line - 1, 0),
    };
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
    const interdiffs = session.loadedInterdiffs.map((i) => i.set);
    const versions = (
      await Promise.all([...session.outdated.values()].map((position) => this.versionOf(session, position)))
    ).filter((set, i, all): set is ChangeSet => !!set && all.indexOf(set) === i);
    // The diff shown is told by its tab, whichever way it was opened: the changes since the last review go
    // through their own comments; the merge request goes on to the outdated ones, each in its version.
    const shown = this.shownSet([session.changeSet, ...interdiffs, ...versions]);
    const chain = shown && interdiffs.includes(shown) ? [shown] : [session.changeSet, ...versions];
    const sides = chain.map(sidesOf);
    const locate = (uri: vscode.Uri) => {
      for (const [group, map] of sides.entries()) {
        const side = map.get(uri.toString());
        if (side) return { group, ...side };
      }
      return undefined;
    };
    const targets = session.threads
      .filter((t) => t.range)
      .map((thread) => ({ thread, line: thread.range!.start.line, at: locate(thread.uri) }))
      .filter((t): t is typeof t & { at: NonNullable<typeof t.at> } => !!t.at)
      .sort((a, b) => a.at.group - b.at.group || a.at.index - b.at.index || a.line - b.line);
    if (targets.length === 0) {
      vscode.window.setStatusBarMessage(t('Kleio: the merge request has no comments in the code'), 3000);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const here = editor && locate(editor.document.uri);
    const key = here
      ? [here.group, here.index, editor!.selection.active.line]
      : [shown ? chain.indexOf(shown) : 0, -1, -1];
    const compare = (t: (typeof targets)[number]) =>
      t.at.group - key[0] || t.at.index - key[1] || t.line - key[2];
    const target =
      direction === 1
        ? targets.find((t) => compare(t) > 0)
        : [...targets].reverse().find((t) => compare(t) < 0);
    if (!target) {
      vscode.window.setStatusBarMessage(
        direction === 1 ? t('Kleio: this is the last comment') : t('Kleio: this is the first comment'),
        3000,
      );
      return;
    }
    target.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const set = chain[target.at.group];
    const visible = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === target.thread.uri.toString(),
    );
    if (visible && set === shown && here?.index === target.at.index) {
      const position = new vscode.Position(target.line, 0);
      visible.selection = new vscode.Selection(position, position);
      visible.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      return;
    }
    const onNew = target.at.side === 'new';
    await this.navigator.open(set, target.at.index, 'first', { line: onNew ? target.line : undefined });
    if (!onNew) revealOld(set, target.at.index, target.line);
  }

  /**
   * The change set the active diff tab is of. Its left side tells it, as each set has its own; the right
   * side of the merge request is also that of the changes since the last review.
   */
  private shownSet(sets: ChangeSet[]): ChangeSet | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff)) return undefined;
    const original = input.original.toString();
    const modified = input.modified.toString();
    const scored = sets
      .map((set) => {
        const sides = sidesOf(set);
        return { set, score: (sides.has(original) ? 2 : 0) + (sides.has(modified) ? 1 : 0) };
      })
      .filter((s) => s.score > 0);
    const best = Math.max(0, ...scored.map((s) => s.score));
    const candidates = scored.filter((s) => s.score === best).map((s) => s.set);
    const navigated = this.navigator.shown;
    return candidates.find((set) => set === navigated) ?? candidates[0];
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

  /** Ends the review; `forget` is false when only the window closes, so that it comes back after a reload. */
  private end(forget = true): void {
    for (const thread of this.session?.threads ?? []) thread.dispose();
    this.session = undefined;
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

type Place = { uri: vscode.Uri; range: vscode.Range };

/** The version under review. */
function current(session: Session): Version {
  return { baseSha: session.refs.baseSha, headSha: session.refs.headSha };
}

/** Where a discussion stands in the version of the merge request it was made on. */
function versionPlaceOf(root: string, position: DiffPosition): Place {
  const onNew = position.newLine !== undefined;
  const uri = onNew
    ? revisionUri(root, position.headSha, position.newPath)
    : revisionUri(root, position.baseSha, position.oldPath);
  const line = (onNew ? position.newLine : position.oldLine) ?? 1;
  const start = position.lineRange?.start;
  const first = (onNew ? start?.newLine : start?.oldLine) ?? line;
  return { uri, range: new vscode.Range(Math.min(first, line) - 1, 0, line - 1, 0) };
}

function samePlace(a: Place, b: Place): boolean {
  return a.uri.toString() === b.uri.toString() && a.range.isEqual(b.range);
}

/** The documents of both sides of each file of a change set, as the diff viewer opens them. */
function sidesOf(set: ChangeSet): Map<string, { index: number; side: Side }> {
  const sides = new Map<string, { index: number; side: Side }>();
  const root = set.repository.root;
  set.files.forEach((change, index) => {
    if (change.status !== 'A' && set.left !== undefined)
      sides.set(revisionUri(root, set.left, change.oldPath ?? change.path).toString(), {
        index,
        side: 'old',
      });
    if (change.status !== 'D') {
      const right = set.rightUris?.get(change.path) ?? revisionUri(root, set.right, change.path);
      sides.set(right.toString(), { index, side: 'new' });
    }
  });
  return sides;
}

/** The diff reveals lines of its new side; a line of the old side is revealed there once the diff is shown. */
function revealOld(set: ChangeSet, index: number, line: number): void {
  const change = set.files[index];
  if (!change || set.left === undefined) return;
  const uri = revisionUri(set.repository.root, set.left, change.oldPath ?? change.path).toString();
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
  const position = new vscode.Position(line, 0);
  editor?.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(displayLanguage(), { dateStyle: 'short', timeStyle: 'short' }).format(date);
}
