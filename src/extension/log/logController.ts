import * as vscode from 'vscode';
import type { RepositorySnapshot } from '../../shared/model';
import type { ChangeSetView, HostMessage, WebviewMessage } from '../../shared/protocol';
import type { GitActions } from '../actions/gitActions';
import { commitChangeSet, describeRange, rangeChangeSet, type ChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import { WORKTREE, type Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import type { HostingActions } from '../hosting/hostingActions';
import type { HostingService } from '../hosting/hostingService';
import type { MergeRequestCards } from '../hosting/mergeRequestCards';

const FOCUS_KEY = 'grove.focus';
const FAVORITES_KEY = 'grove.favorites';

export interface HistoryTarget {
  repository: Repository;
  /** Path relative to the repository root. */
  path: string;
  /** 1-based inclusive lines for the history of a fragment. */
  range?: { start: number; end: number };
  title: string;
}

export interface LogServices {
  context: vscode.ExtensionContext;
  repositories: RepositoryManager;
  navigator: ChangeSetNavigator;
  actions: GitActions;
  hosting: HostingService;
  hostingActions: HostingActions;
  cards: MergeRequestCards;
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
      services.hosting.onDidChange(() => void this.loadHosting(true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('grove.autolinks') || e.affectsConfiguration('grove.hosting')) {
          void this.loadHosting(true);
        }
      }),
    );
  }

  /** Brings the given commit into view, e.g. when coming from blame; waits for the first load if needed. */
  revealCommit(hash: string): void {
    if (this.snapshot) this.post({ type: 'revealCommit', hash });
    else this.pendingReveal = hash;
  }

  private async handle(message: WebviewMessage): Promise<void> {
    try {
      await this.dispatch(message);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Grove: ${text}`);
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
      case 'openUrl':
        return this.services.hostingActions.openUrl(message.url);
      case 'openMergeRequest':
        if (this.repository) await this.services.hostingActions.mergeRequest(this.repository, message.number);
        return;
      case 'loadMergeRequestCard':
        return this.loadCard(message.number);
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
      case 'retryPipeline':
        if (this.repository) {
          await this.services.cards.retryPipeline(this.repository, message.pipelineId);
          await this.loadCard(message.number);
        }
        return;
      case 'selectRepository':
        this.repository = await this.services.repositories.get(message.root);
        return this.load();
      case 'setFocus':
        await this.setStored(FOCUS_KEY, message.revisions);
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

  private async load(): Promise<void> {
    const version = ++this.loadVersion;
    this.repository ??= this.services.repositories.all[0];
    if (!this.repository) {
      this.post({ type: 'noRepository' });
      return;
    }
    this.post({ type: 'loading', value: true });
    try {
      const snapshot = this.history
        ? await this.historySnapshot(this.history)
        : await this.repository.snapshot({ revisions: await this.existingRevisions(this.stored(FOCUS_KEY)) });
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
      range ? repository.lineHistory(path, range.start, range.end) : repository.fileHistory(path),
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
          mergeRequests: hosting?.mergeRequests ?? {},
          defaultBranch: hosting?.defaultBranch,
          merged,
          autolinks: this.services.hosting.autolinks(hosting),
          api: hosting?.api ?? 'none',
          mergeRequestInfo: hosting?.mergeRequestInfo ?? {},
          pipelines: hosting?.pipelines ?? {},
        },
      });
    } catch {
      // Hosting details are an extra; the log works without them.
    }
  }

  private async loadCard(number: number): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    const result = await this.services.cards.card(repository, number);
    this.post({ type: 'mergeRequestCard', number, ...result });
  }

  /** Focus may name branches that were deleted since; they are skipped instead of failing the log. */
  private async existingRevisions(revisions: string[]): Promise<string[]> {
    const repository = this.repository;
    if (!repository) return [];
    const resolved = await Promise.all(
      revisions.map(async (r) => ((await repository.revParse(r)) ? r : undefined)),
    );
    return resolved.filter((r): r is string => r !== undefined);
  }

  private postSnapshot(): void {
    if (!this.snapshot) return;
    this.post({
      type: 'snapshot',
      repositories: this.services.repositories.all.map((r) => ({ root: r.root, name: r.name })),
      snapshot: this.snapshot,
      focus: this.history ? [] : this.stored(FOCUS_KEY),
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
            `Коммиты ${oldest.hash.slice(0, 8)}…${newest.hash.slice(0, 8)}`,
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
    if (!vscode.workspace.getConfiguration('grove').get<boolean>('history.showDiffOnSelect', true)) return;
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
    const filePath = this.historyPaths[hash] ?? this.history?.path;
    const index = changeSet.files.findIndex((f) => f.path === filePath || f.oldPath === filePath);
    return index < 0 ? undefined : index;
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
      case 'copyHash':
        await vscode.env.clipboard.writeText(hash);
        return;
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
          `${hash.slice(0, 8)} ↔ рабочая копия`,
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
      case 'showDiffWithCurrent': {
        const head = snapshot.head.branch ?? snapshot.head.hash;
        if (!head) return;
        const changeSet = await rangeChangeSet(repository, head, ref.name, `${head} ↔ ${ref.name}`);
        return this.openChangeSet(changeSet);
      }
      case 'copyName':
        await vscode.env.clipboard.writeText(ref.name);
        return;
      case 'openInHosting':
        return this.services.hostingActions.branch(repository, ref);
      case 'createMergeRequest':
        return this.services.hostingActions.createMergeRequest(repository, ref);
    }
  }

  private async openChangeSet(changeSet: ChangeSet): Promise<void> {
    if (changeSet.files.length === 0) {
      void vscode.window.showInformationMessage(`${changeSet.title}: различий нет.`);
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
