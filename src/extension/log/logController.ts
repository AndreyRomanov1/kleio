import * as vscode from 'vscode';
import type { LogQuery, Ref, RepositorySnapshot } from '../../shared/model';
import type { ChangeSetView, HostMessage, MergeRequestCardView, WebviewMessage } from '../../shared/protocol';
import type { GitActions } from '../actions/gitActions';
import type { SyncActions } from '../actions/syncActions';
import { commitChangeSet, describeRange, rangeChangeSet, type ChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import { WORKTREE, type Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import type { HostingActions } from '../hosting/hostingActions';
import type { RemoteActions } from '../actions/remoteActions';
import type { HostingService } from '../hosting/hostingService';
import type { PushDialog } from '../push/pushDialog';
import type { RebaseDialog } from '../rebase/rebaseDialog';
import type { MergeRequestCards } from '../hosting/mergeRequestCards';
import type { ReviewController } from '../review/reviewController';
import { t } from '../../shared/l10n';

const FOCUS_KEY = 'kleio.focus';
/** Commits loaded at once; huge histories are loaded further as the log is scrolled down. */
const LOG_PAGE = 10_000;
const FAVORITES_KEY = 'kleio.favorites';

export interface HistoryTarget {
  repository: Repository;
  /** Path relative to the repository root. */
  path: string;
  /** 1-based inclusive lines for the history of a fragment. */
  range?: { start: number; end: number };
  /** The history of everything inside a folder. */
  folder?: boolean;
  title: string;
}

export interface LogServices {
  context: vscode.ExtensionContext;
  repositories: RepositoryManager;
  navigator: ChangeSetNavigator;
  actions: GitActions;
  sync: SyncActions;
  push: PushDialog;
  rebase: RebaseDialog;
  hosting: HostingService;
  hostingActions: HostingActions;
  remotes: RemoteActions;
  cards: MergeRequestCards;
  review: ReviewController;
}

/** Serves one log webview, wherever it is placed, or a history view of a file or of a fragment. */
export class LogController implements vscode.Disposable {
  private repository?: Repository;
  private snapshot?: RepositorySnapshot;
  private pendingReveal?: string;
  /** Path of the history file in each commit, as it may have been renamed. */
  private historyPaths: Record<string, string> = {};
  /** 1-based line where the traced fragment was changed in each commit. */
  private historyLines: Record<string, number> = {};
  private historyDiffTimer?: NodeJS.Timeout;
  private readonly changeSets = new Map<number, ChangeSet>();
  private nextChangeSetId = 1;
  private loadVersion = 0;
  private logLimit = LOG_PAGE;
  private query: LogQuery = {};
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly services: LogServices,
    private readonly history?: HistoryTarget,
  ) {
    this.repository = history?.repository;
    this.disposables.push(
      webview.onDidReceiveMessage((message: WebviewMessage) => this.handle(message)),
      services.repositories.onDidChangeRepository((repository) => {
        if (repository === this.repository) void this.load();
      }),
      services.repositories.onDidChangeRepositories(() => {
        if (!this.repository) void this.load();
      }),
      services.repositories.onDidChangeCurrent((repository) => {
        if (this.history || repository === this.repository) return;
        this.repository = repository;
        this.logLimit = LOG_PAGE;
        this.query = {};
        void this.load();
      }),
      services.hosting.onDidChange(() => void this.loadHosting(true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('kleio.autolinks') || e.affectsConfiguration('kleio.hosting')) {
          void this.loadHosting(true);
        }
      }),
    );
  }

  /** Brings the given commit into view, e.g. when coming from blame; waits for the first load if needed. */
  revealCommit(hash: string): void {
    if (this.snapshot) void this.revealLoaded(hash);
    else this.pendingReveal = hash;
  }

  /** A commit older than the loaded part of the log is reached by loading more of it. */
  private async revealLoaded(hash: string): Promise<void> {
    const has = () => this.snapshot?.commits.some((c) => c.hash === hash || c.hash.startsWith(hash));
    while (this.snapshot?.truncated && !has()) {
      this.logLimit = this.snapshot.commits.length * 2;
      await this.load();
    }
    this.post({ type: 'revealCommit', hash });
  }

  private async handle(message: WebviewMessage): Promise<void> {
    try {
      await this.dispatch(message);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Kleio: ${text}`);
    }
  }

  private async dispatch(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
      case 'refresh':
        return this.load();
      case 'fetch':
        if (this.repository) {
          await this.services.actions.fetch(this.repository);
          void this.loadHosting(true);
        }
        return;
      case 'updateProject':
        if (this.repository) await this.services.sync.updateProject(this.repository);
        return;
      case 'push':
        if (this.repository) await this.services.push.open(this.repository);
        return;
      case 'operation':
        return this.operation(message.action);
      case 'openUrl':
        return this.services.hostingActions.openUrl(message.url);
      case 'openMergeRequest':
        if (this.repository) await this.services.hostingActions.mergeRequest(this.repository, message.number);
        return;
      case 'loadMergeRequestCard':
        return this.loadCard(message.number);
      case 'loadMergedMergeRequests':
        return this.loadMerged(message.before);
      case 'loadMoreCommits':
        if (!this.snapshot?.truncated) return;
        this.logLimit = this.snapshot.commits.length + LOG_PAGE;
        return this.load();
      case 'selectHostingRemote':
        if (this.repository) await this.services.hostingActions.selectRemote(this.repository);
        return;
      case 'remoteAction':
        if (this.repository) await this.services.remotes.run(this.repository, message.action, message.remote);
        return;
      case 'connectHosting':
        if (this.repository && (await this.services.cards.connect(this.repository)) && message.number) {
          await this.loadCard(message.number);
        }
        return;
      case 'openJobLog':
        if (this.repository)
          await this.services.cards.openJobLog(
            this.repository,
            message.jobId,
            message.name,
            message.projectId,
          );
        return;
      case 'compareVersions':
        if (this.repository)
          await this.services.review.compareVersions(
            this.repository,
            message.number,
            message.from,
            message.to,
          );
        return;
      case 'startReview':
        if (this.repository)
          await this.services.review.start(
            this.repository,
            message.number,
            message.path,
            message.line,
            message.discussion,
          );
        return;
      case 'postComment':
        if (
          this.repository &&
          (await this.services.review.postGeneral(
            this.repository,
            message.number,
            message.body,
            message.draft ? 'draft' : 'publish',
          ))
        ) {
          await this.loadCard(message.number);
        }
        return;
      case 'publishDrafts':
        if (this.repository) {
          await this.services.review.publishDraftsOf(this.repository, message.number);
          await this.loadCard(message.number);
        }
        return;
      case 'approveMergeRequest':
      case 'mergeMergeRequest':
      case 'rebaseMergeRequest':
      case 'playJob': {
        const repository = this.repository;
        if (!repository) return;
        const cards = this.services.cards;
        if (message.type === 'approveMergeRequest')
          await cards.approve(repository, message.number, message.approve);
        else if (message.type === 'mergeMergeRequest') await cards.merge(repository, message.number);
        else if (message.type === 'rebaseMergeRequest') await cards.rebase(repository, message.number);
        else await cards.playJob(repository, message.jobId, message.name, message.projectId);
        await this.loadCard(message.number);
        void this.loadHosting(true);
        return;
      }
      case 'retryPipeline':
        if (this.repository) {
          await this.services.cards.retryPipeline(this.repository, message.pipelineId, message.number);
          await this.loadCard(message.number);
        }
        return;
      case 'selectRepository': {
        const repository = await this.services.repositories.get(message.root);
        if (!repository) return;
        this.repository = repository;
        this.logLimit = LOG_PAGE;
        this.query = {};
        this.services.repositories.setCurrent(repository);
        return this.load();
      }
      case 'setFocus':
        await this.setStored(FOCUS_KEY, message.revisions);
        return this.load();
      case 'setQuery':
        this.query = message.query;
        this.logLimit = LOG_PAGE;
        return this.load();
      case 'toggleFavorite': {
        const favorites = this.stored(FAVORITES_KEY);
        const next = favorites.includes(message.fullName)
          ? favorites.filter((f) => f !== message.fullName)
          : [...favorites, message.fullName];
        await this.setStored(FAVORITES_KEY, next);
        return this.postSnapshot();
      }
      case 'selectCommits':
        return this.selectCommits(message.requestId, message.hashes);
      case 'showStash':
        return this.showStash(message.requestId, message.hash);
      case 'fileAction':
        return this.fileAction(message);
      case 'commitAction':
        return this.commitAction(message.action, message.hash);
      case 'commitsAction':
        if (!this.repository) return;
        if (message.action === 'cherryPick' || message.action === 'savePatch') {
          // Oldest first, as they were made; the log lists them newest first.
          const order = new Map(this.snapshot?.commits.map((c, i) => [c.hash, i]));
          const hashes = [...message.hashes].sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0));
          if (message.action === 'savePatch') return this.services.actions.savePatch(this.repository, hashes);
          return this.services.sync.cherryPick(this.repository, ...hashes);
        }
        if (message.action === 'showChanges') return this.openRangeDiff(message.hashes);
        if (message.action === 'squash')
          return this.services.rebase.open(this.repository, { kind: 'squash', hashes: message.hashes });
        return this.services.rebase.drop(this.repository, message.hashes);
      case 'refAction':
        return this.refAction(message.action, message.fullName);
      case 'openCommitDiff':
        return this.openCommitDiff(message.hash);
      case 'openWorktree':
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(message.path), {
          forceNewWindow: message.newWindow,
        });
        return;
    }
  }

  private async operation(action: Extract<WebviewMessage, { type: 'operation' }>['action']): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    if (!(await this.services.sync.operationAction(repository, action))) return this.load();
  }

  private async load(): Promise<void> {
    const version = ++this.loadVersion;
    this.repository ??= this.services.repositories.current;
    if (!this.repository) {
      this.post({ type: 'noRepository' });
      return;
    }
    this.post({ type: 'loading', value: true });
    try {
      const snapshot = this.history
        ? await this.historySnapshot(this.history)
        : await this.repository.snapshot({
            revisions: await this.existingRevisions(this.stored(FOCUS_KEY)),
            limit: this.logLimit,
            query: this.query,
          });
      if (version !== this.loadVersion) return;
      this.snapshot = snapshot;
      this.postSnapshot();
      void this.loadHosting(false);
    } finally {
      if (version === this.loadVersion) this.post({ type: 'loading', value: false });
    }
  }

  private async historySnapshot(target: HistoryTarget): Promise<RepositorySnapshot> {
    const { repository, path, range } = target;
    const [history, refs, head] = await Promise.all([
      range
        ? repository.lineHistory(path, range.start, range.end)
        : target.folder
          ? repository.folderHistory(path)
          : repository.fileHistory(path),
      repository.refs(),
      repository.head(),
    ]);
    this.historyPaths = history.paths;
    this.historyLines = history.lines;
    return { root: repository.root, head, commits: history.commits, refs, worktrees: [], stashes: [] };
  }

  /** Merge requests need the network, so they come after the log is already shown. */
  private async loadHosting(refresh: boolean): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    try {
      const hosting = await this.services.hosting.hosting(repository, refresh);
      const merged = hosting?.defaultBranch ? await repository.mergedBranches(hosting.defaultBranch) : [];
      this.post({
        type: 'hosting',
        hosting: {
          name: hosting?.links?.name,
          kind: hosting?.links?.kind,
          remote: hosting?.remoteName,
          remoteCount: hosting?.remoteCount ?? 0,
          mergeRequests: hosting?.mergeRequests ?? {},
          defaultBranch: hosting?.defaultBranch,
          merged,
          autolinks: this.services.hosting.autolinks(hosting),
          api: hosting?.api ?? 'none',
          mergeRequestInfo: hosting?.mergeRequestInfo ?? {},
          pipelines: hosting?.pipelines ?? {},
        },
      });
      if (!this.history && hosting?.links?.kind === 'gitlab' && hosting.api === 'available')
        void this.services.review.follow(repository, this.currentMergeRequest(hosting));
    } catch {
      // Hosting details are an extra; the log works without them.
    }
  }

  /**
   * The open merge request of the current branch: the one whose head the branch's upstream is at, as the
   * agent's local commits move the branch itself ahead of it.
   */
  private currentMergeRequest(hosting: {
    mergeRequests: Record<string, number[]>;
    mergeRequestInfo: Record<number, { state: string }>;
  }): number | undefined {
    const snapshot = this.snapshot;
    const branch = snapshot?.head.branch;
    if (!snapshot || !branch) return undefined;
    const local = snapshot.refs.find((r) => r.kind === 'head' && r.name === branch);
    const upstream = local?.upstream ? snapshot.refs.find((r) => r.fullName === local.upstream) : undefined;
    for (const hash of [upstream?.hash, local?.hash]) {
      if (!hash) continue;
      const iid = hosting.mergeRequests[hash]?.find((n) => hosting.mergeRequestInfo[n]?.state === 'opened');
      if (iid !== undefined) return iid;
    }
    return undefined;
  }

  /** Always answers, so the log does not wait forever; without access or on an error it stops asking. */
  private async loadMerged(before: number): Promise<void> {
    const repository = this.repository;
    if (!repository || this.history) return;
    const merged = await this.services.hosting.mergedBefore(repository, before).catch(() => undefined);
    this.post({
      type: 'mergedMergeRequests',
      byCommit: merged?.byCommit ?? {},
      info: merged?.info ?? {},
      coveredUntil: merged?.coveredUntil,
      done: merged?.done ?? true,
    });
  }

  private async versions(repository: Repository, number: number): Promise<MergeRequestCardView['versions']> {
    const api = await this.services.hosting.gitlab(repository, false).catch(() => undefined);
    const versions = await api?.versions(number).catch(() => undefined);
    if (!versions) return undefined;
    const seen = new Set(await this.services.review.seenHeads(repository, number));
    return [...versions].reverse().map((v) => ({ ...v, seen: seen.has(v.headSha) }));
  }

  private async loadCard(number: number): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    const result = await this.services.cards.card(repository, number);
    if ('card' in result) {
      result.card.reviewing = this.services.review.activeMergeRequest === number;
      if (result.card.kind !== 'github') result.card.versions = await this.versions(repository, number);
    }
    this.post({ type: 'mergeRequestCard', number, ...result });
  }

  /** Focus may name branches that were deleted since; they are skipped instead of failing the log. */
  private async existingRevisions(revisions: string[]): Promise<string[]> {
    const repository = this.repository;
    if (!repository) return [];
    // A range such as `main..feature` is valid when both of its ends are.
    const exists = async (revision: string) => {
      const ends = revision.split(/\.\.\.?/).filter(Boolean);
      return ends.length > 0 && (await Promise.all(ends.map((e) => repository.revParse(e)))).every(Boolean);
    };
    const resolved = await Promise.all(revisions.map(async (r) => ((await exists(r)) ? r : undefined)));
    return resolved.filter((r): r is string => r !== undefined);
  }

  private postSnapshot(): void {
    if (!this.snapshot) return;
    this.post({
      type: 'snapshot',
      repositories: this.services.repositories.all.map((r) => ({ root: r.root, name: r.name })),
      snapshot: this.snapshot,
      focus: this.history ? [] : this.stored(FOCUS_KEY),
      query: this.history ? {} : this.query,
      favorites: this.stored(FAVORITES_KEY),
      history: this.history ? { title: this.history.title } : undefined,
    });
    if (this.pendingReveal) {
      this.post({ type: 'revealCommit', hash: this.pendingReveal });
      this.pendingReveal = undefined;
    }
  }

  private async selectCommits(requestId: number, hashes: string[]): Promise<void> {
    const repository = this.repository;
    if (!repository || hashes.length === 0) return;
    const commits = await Promise.all(hashes.map((h) => repository.commitDetails(h)));
    const newest = commits[0];
    const oldest = commits[commits.length - 1];
    const changeSet =
      commits.length === 1
        ? await commitChangeSet(repository, newest.hash, newest.parents)
        : await rangeChangeSet(
            repository,
            oldest.parents[0],
            newest.hash,
            t('Commits {0}…{1}', oldest.hash.slice(0, 8), newest.hash.slice(0, 8)),
          );
    const view = this.register(changeSet);
    if (this.history && commits.length === 1) view.focusIndex = this.historyFileIndex(changeSet, newest.hash);
    this.post({ type: 'details', requestId, commits, changeSet: view });
    if (this.history && commits.length === 1 && view.focusIndex !== undefined) {
      this.showHistoryDiff(changeSet, view.focusIndex, newest.hash);
    }
  }

  /**
   * As in Rider's file history, the diff of the selected commit is shown next to the list; focus stays in the
   * list, so arrow keys walk through the history. Debounced for fast scrolling.
   */
  private showHistoryDiff(changeSet: ChangeSet, index: number, hash: string): void {
    if (!vscode.workspace.getConfiguration('kleio').get<boolean>('history.showDiffOnSelect', true)) return;
    clearTimeout(this.historyDiffTimer);
    this.historyDiffTimer = setTimeout(() => {
      const line = this.historyLines[hash];
      void this.services.navigator.open(changeSet, index, 'first', {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        line: line === undefined ? undefined : line - 1,
      });
    }, 200);
  }

  /** Index of the traced file in a commit of a history view; it may have had another name back then. */
  private historyFileIndex(changeSet: ChangeSet, hash: string): number | undefined {
    if (this.history?.folder) {
      const prefix = this.history.path ? `${this.history.path}/` : '';
      const index = changeSet.files.findIndex(
        (f) => f.path.startsWith(prefix) || f.oldPath?.startsWith(prefix),
      );
      return index < 0 ? undefined : index;
    }
    const filePath = this.historyPaths[hash] ?? this.history?.path;
    const index = changeSet.files.findIndex((f) => f.path === filePath || f.oldPath === filePath);
    return index < 0 ? undefined : index;
  }

  /**
   * What a branch changes, as its merge request shows it: from where it left the branch it goes into — the
   * target of its open merge request, e.g. the lower branch of a stack, or else the default branch.
   */
  private async branchTarget(repository: Repository, ref: Ref): Promise<string | undefined> {
    const hosting = await this.services.hosting.hosting(repository, false).catch(() => undefined);
    const iid = hosting?.mergeRequests[ref.hash]?.find(
      (n) => hosting.mergeRequestInfo[n]?.state === 'opened',
    );
    const target = iid === undefined ? undefined : hosting?.mergeRequestInfo[iid]?.targetBranch;
    const candidates = [
      ...(target ? [`${hosting?.remoteName ?? 'origin'}/${target}`, target] : []),
      ...(hosting?.defaultBranch ? [hosting.defaultBranch] : []),
      'origin/main',
      'origin/master',
      'main',
      'master',
    ].filter((name) => name !== ref.name);
    for (const name of candidates) if (await repository.revParse(name)) return name;
    return undefined;
  }

  /** The changes of several commits together: from the parent of the oldest to the newest. */
  private async openRangeDiff(hashes: string[]): Promise<void> {
    const repository = this.repository;
    if (!repository || !hashes.length) return;
    const order = new Map(this.snapshot?.commits.map((c, i) => [c.hash, i]));
    const sorted = [...hashes].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const newest = sorted[0];
    const oldest = await repository.commitDetails(sorted[sorted.length - 1]);
    const changeSet = await rangeChangeSet(
      repository,
      oldest.parents[0],
      newest,
      t('Commits {0}…{1}', oldest.hash.slice(0, 8), newest.slice(0, 8)),
    );
    return this.openChangeSet(changeSet);
  }

  private async openCommitDiff(hash: string): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    const details = await repository.commitDetails(hash);
    const changeSet = await commitChangeSet(repository, hash, details.parents);
    if (changeSet.files.length === 0) return this.openChangeSet(changeSet);
    const index = this.history ? (this.historyFileIndex(changeSet, hash) ?? 0) : 0;
    return this.services.navigator.open(changeSet, index);
  }

  private async showStash(requestId: number, hash: string): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    const details = await repository.commitDetails(hash);
    const changeSet = await rangeChangeSet(repository, details.parents[0], hash, 'Stash');
    this.post({ type: 'details', requestId, commits: [details], changeSet: this.register(changeSet) });
  }

  private register(changeSet: ChangeSet): ChangeSetView {
    const id = this.nextChangeSetId++;
    this.changeSets.set(id, changeSet);
    // Only the latest few sets can still be clicked in the details pane.
    for (const key of this.changeSets.keys()) if (key < id - 20) this.changeSets.delete(key);
    return { id, title: changeSet.title, range: describeRange(changeSet), files: changeSet.files };
  }

  private async fileAction(message: Extract<WebviewMessage, { type: 'fileAction' }>): Promise<void> {
    const changeSet = this.changeSets.get(message.changeSetId);
    if (!changeSet) return;
    const navigator = this.services.navigator;
    switch (message.action) {
      case 'openDiff':
        return navigator.open(changeSet, message.index);
      case 'openCurrent':
        return navigator.openCurrent(changeSet, message.index);
      case 'openRevision':
        return navigator.openRevision(changeSet, message.index);
      case 'compareWithWorktree':
        return navigator.compareWithWorktree(changeSet, message.index);
      case 'copyPath':
        await vscode.env.clipboard.writeText(changeSet.files[message.index]?.path ?? '');
        return;
    }
  }

  private async commitAction(
    action: Extract<WebviewMessage, { type: 'commitAction' }>['action'],
    hash: string,
  ): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    const actions = this.services.actions;
    switch (action) {
      case 'checkout':
        return actions.checkoutRevision(repository, hash);
      case 'newBranch':
        return actions.createBranch(repository, hash);
      case 'newTag':
        return actions.createTag(repository, hash);
      case 'revert': {
        const details = await repository.commitDetails(hash);
        return actions.revert(repository, hash, details.parents);
      }
      case 'cherryPick':
        return this.services.sync.cherryPick(repository, hash);
      case 'interactiveRebase':
        return this.services.rebase.open(repository, { kind: 'from', hash });
      case 'reword':
        return this.services.rebase.open(repository, { kind: 'reword', hash });
      case 'fixupIntoParent':
        return this.services.rebase.fixupIntoParent(repository, hash);
      case 'reset':
        if (this.snapshot) return this.services.sync.reset(repository, this.snapshot, hash);
        return;
      case 'copyHash':
        await vscode.env.clipboard.writeText(hash);
        return;
      case 'savePatch':
        return this.services.actions.savePatch(repository, [hash]);
      case 'showChanges':
        return this.openCommitDiff(hash);
      case 'copySubject': {
        const details = await repository.commitDetails(hash);
        await vscode.env.clipboard.writeText(details.message.split('\n')[0]);
        return;
      }
      case 'openInHosting':
        return this.services.hostingActions.commit(repository, hash, 'open');
      case 'copyHostingLink':
        return this.services.hostingActions.commit(repository, hash, 'copy');
      case 'compareWithWorktree': {
        const changeSet = await rangeChangeSet(
          repository,
          hash,
          WORKTREE,
          t('{0} ↔ working tree', hash.slice(0, 8)),
        );
        return this.openChangeSet(changeSet);
      }
    }
  }

  private async refAction(
    action: Extract<WebviewMessage, { type: 'refAction' }>['action'],
    fullName: string,
  ): Promise<void> {
    const repository = this.repository;
    const snapshot = this.snapshot;
    const ref = snapshot?.refs.find((r) => r.fullName === fullName);
    if (!repository || !snapshot || !ref) return;
    const actions = this.services.actions;
    switch (action) {
      case 'checkout':
        return actions.checkoutRef(repository, snapshot, ref);
      case 'newBranch':
        return actions.createBranch(
          repository,
          ref.name,
          ref.kind === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : '',
        );
      case 'deleteBranch':
        return actions.deleteBranch(repository, snapshot, ref);
      case 'deleteRemoteBranch':
        return actions.deleteRemoteBranch(repository, ref);
      case 'fetchBranch':
        return actions.fetch(
          repository,
          ref.kind === 'remote' ? ref : snapshot.refs.find((r) => r.fullName === ref.upstream),
        );
      case 'showBranchChanges': {
        const target = await this.branchTarget(repository, ref);
        if (!target) {
          void vscode.window.showWarningMessage(
            t('Kleio: the branch to compare {0} with is unknown.', ref.name),
          );
          return;
        }
        const base = (await repository.git.run(['merge-base', target, ref.hash])).trim();
        const changeSet = await rangeChangeSet(
          repository,
          base,
          ref.name,
          t('{0} since {1}', ref.name, target),
        );
        return this.openChangeSet(changeSet);
      }
      case 'showDiffWithCurrent': {
        const head = snapshot.head.branch ?? snapshot.head.hash;
        if (!head) return;
        const changeSet = await rangeChangeSet(repository, head, ref.name, `${head} ↔ ${ref.name}`);
        return this.openChangeSet(changeSet);
      }
      case 'merge':
        return this.services.sync.merge(repository, snapshot, ref);
      case 'rebaseOnto':
        return this.services.sync.rebase(repository, snapshot, ref.name);
      case 'checkoutToWorktree':
        return actions.checkoutToWorktree(repository, snapshot, ref);
      case 'checkoutAndRebase':
        return actions.checkoutAndRebase(repository, snapshot, ref);
      case 'updateBranch':
        return this.services.sync.updateBranch(repository, snapshot, ref);
      case 'push':
        return this.services.push.open(repository, ref.name);
      case 'copyName':
        await vscode.env.clipboard.writeText(ref.name);
        return;
      case 'openInHosting':
        return this.services.hostingActions.branch(repository, ref);
      case 'createMergeRequest':
        return this.services.hostingActions.createMergeRequest(repository, ref);
      case 'rename':
        return actions.renameBranch(repository, ref);
      case 'setUpstream':
        return actions.setUpstream(repository, snapshot, ref);
      case 'pushTag':
        return actions.pushTag(repository, ref);
      case 'deleteTag':
        return actions.deleteTag(repository, ref);
    }
  }

  private async openChangeSet(changeSet: ChangeSet): Promise<void> {
    if (changeSet.files.length === 0) {
      void vscode.window.showInformationMessage(t('{0}: no differences.', changeSet.title));
      return;
    }
    await this.services.navigator.open(changeSet, 0);
  }

  private stored(key: string): string[] {
    return this.services.context.workspaceState.get<string[]>(`${key}:${this.repository?.root}`, []);
  }

  private setStored(key: string, value: string[]): Thenable<void> {
    return this.services.context.workspaceState.update(`${key}:${this.repository?.root}`, value);
  }

  private post(message: HostMessage): void {
    void this.webview.postMessage(message);
  }

  dispose(): void {
    clearTimeout(this.historyDiffTimer);
    for (const d of this.disposables) d.dispose();
  }
}
