import * as vscode from 'vscode';
import type { RebaseEntry, RebaseHostMessage, RebaseWebviewMessage } from '../../shared/rebaseProtocol';
import type { SyncActions } from '../actions/syncActions';
import { commitChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import type { Repository } from '../git/repository';
import { renderHtml, webviewOptions } from '../webviewHtml';
import { t } from '../../shared/l10n';

const PANEL_TYPE = 'kleio.rebase';

export type RebaseRequest =
  /** Everything from this commit up to HEAD, as is. */
  | { kind: 'from'; hash: string }
  /** The same, with this commit selected for a new message. */
  | { kind: 'reword'; hash: string }
  /** The given commits put together after the oldest of them and squashed into it. */
  | { kind: 'squash'; hashes: string[] };

interface Range {
  branch: string;
  base?: string;
  hashes: string[];
}

/** Rider's interactive rebase dialog: the plan as a table, messages edited in place, then one run of git. */
export class RebaseDialog implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private repository?: Repository;
  private request?: RebaseRequest;
  private range?: Range;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly navigator: ChangeSetNavigator,
    private readonly sync: SyncActions,
  ) {}

  async open(repository: Repository, request: RebaseRequest): Promise<void> {
    this.repository = repository;
    this.request = request;
    if (this.panel) {
      this.panel.reveal();
      await this.load();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      'Interactive rebase',
      vscode.ViewColumn.Active,
      { ...webviewOptions(this.context.extensionUri), retainContextWhenHidden: true },
    );
    panel.webview.html = renderHtml(panel.webview, this.context.extensionUri, 'rebase');
    panel.webview.onDidReceiveMessage((message: RebaseWebviewMessage) => void this.handle(message));
    panel.onDidDispose(() => (this.panel = undefined));
    this.panel = panel;
  }

  /** Removes commits from the current branch without opening the dialog. */
  async drop(repository: Repository, hashes: string[]): Promise<void> {
    const range = await this.rangeFor(repository, oldestOf(await this.order(repository, hashes)));
    if (typeof range === 'string') return void vscode.window.showWarningMessage(range);
    const ok = await vscode.window.showWarningMessage(
      hashes.length === 1
        ? t('Drop commit {0} from {1}?', hashes[0].slice(0, 8), range.branch)
        : t('Drop {0} commits from {1}?', hashes.length, range.branch),
      { modal: true, detail: t('The branch is rewritten; the commits stay reachable through the reflog.') },
      t('Drop'),
    );
    if (!ok) return;
    const drop = new Set(hashes);
    const entries = await this.entries(repository, range.hashes, (hash) =>
      drop.has(hash) ? 'drop' : 'pick',
    );
    await this.sync.interactiveRebase(repository, range.base, entries, range.branch);
  }

  /** Melds a commit into the one before it, keeping the message of the earlier one. */
  async fixupIntoParent(repository: Repository, hash: string): Promise<void> {
    const details = await repository.commitDetails(hash);
    const parent = details.parents[0];
    if (!parent) return void vscode.window.showWarningMessage(t('The first commit has no previous one.'));
    const range = await this.rangeFor(repository, parent);
    if (typeof range === 'string') return void vscode.window.showWarningMessage(range);
    const entries = await this.entries(repository, range.hashes, (h) => (h === hash ? 'fixup' : 'pick'));
    await this.sync.interactiveRebase(repository, range.base, entries, range.branch);
  }

  private async handle(message: RebaseWebviewMessage): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    try {
      switch (message.type) {
        case 'ready':
          return await this.load();
        case 'selectCommit': {
          const details = await repository.commitDetails(message.hash);
          const changeSet = await commitChangeSet(repository, message.hash, details.parents);
          this.post({ type: 'files', hash: message.hash, files: changeSet.files });
          return;
        }
        case 'openFile': {
          const details = await repository.commitDetails(message.hash);
          const changeSet = await commitChangeSet(repository, message.hash, details.parents);
          return await this.navigator.open(changeSet, message.index, 'first', {
            viewColumn: vscode.ViewColumn.Beside,
          });
        }
        case 'start': {
          const range = this.range;
          if (!range) return;
          const head = await repository.revParse('HEAD');
          if (head !== range.hashes[range.hashes.length - 1]) {
            this.post({
              type: 'error',
              message: t('The branch changed while the dialog was open. Open it again.'),
            });
            return;
          }
          this.panel?.dispose();
          await this.sync.interactiveRebase(repository, range.base, message.entries, range.branch);
          return;
        }
        case 'cancel':
          this.panel?.dispose();
          return;
      }
    } catch (error) {
      this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async load(): Promise<void> {
    const repository = this.repository;
    const request = this.request;
    if (!repository || !request) return;
    const hashes = request.kind === 'squash' ? await this.order(repository, request.hashes) : [request.hash];
    const range = await this.rangeFor(repository, oldestOf(hashes));
    if (typeof range === 'string') {
      this.range = undefined;
      this.post({ type: 'error', message: range });
      return;
    }
    this.range = range;
    const commits = await Promise.all(range.hashes.map((h) => repository.commitDetails(h)));
    const byHash = new Map(commits.map((c) => [c.hash, c]));
    let initial: RebaseEntry[] = commits.map((c) => ({ hash: c.hash, action: 'pick', message: c.message }));
    if (request.kind === 'squash') {
      const [target, ...rest] = hashes;
      const squashed = new Set(rest);
      const others = initial.filter((e) => e.hash !== target && !squashed.has(e.hash));
      const message = hashes.map((h) => byHash.get(h)?.message ?? '').join('\n\n');
      initial = [
        { hash: target, action: 'pick', message },
        ...rest.map((hash): RebaseEntry => ({ hash, action: 'squash' })),
        ...others,
      ];
    }
    this.post({
      type: 'state',
      branch: range.branch,
      base: range.base,
      commits: commits.map((c) => ({
        hash: c.hash,
        authorName: c.authorName,
        authorDate: c.authorDate,
        message: c.message,
      })),
      initial,
      focus: request.kind === 'reword' ? request.hash : undefined,
      published: await repository.publishedCount(range.base),
    });
  }

  /**
   * The commits from `oldest` up to HEAD, or why they cannot be rebased: HEAD without a branch, a commit
   * outside the current branch, merges in between (Kleio does not rebuild merges).
   */
  private async rangeFor(repository: Repository, oldest: string): Promise<Range | string> {
    const head = await repository.head();
    if (!head.branch || !head.hash) return t('HEAD has no branch: check out a branch first.');
    if ((await repository.operation()) !== undefined)
      return t('A merge or rebase is in progress: finish or abort it first.');
    if (!(await repository.isAncestor(oldest, head.hash)))
      return t('Commit {0} is not on the current branch {1}.', oldest.slice(0, 8), head.branch);
    const base = (await repository.commitDetails(oldest)).parents[0];
    const range = await repository.rebaseRange(base);
    if (range.merges > 0)
      return t(
        'There are merge commits between the chosen commit and HEAD: Kleio does not rebase them interactively.',
      );
    return { branch: head.branch, base, hashes: range.commits.map((c) => c.hash) };
  }

  private async entries(
    repository: Repository,
    hashes: string[],
    action: (hash: string) => RebaseEntry['action'],
  ): Promise<RebaseEntry[]> {
    return Promise.all(
      hashes.map(async (hash) => ({
        hash,
        action: action(hash),
        message: (await repository.commitDetails(hash)).message,
      })),
    );
  }

  /** The commits oldest first. */
  private async order(repository: Repository, hashes: string[]): Promise<string[]> {
    const dated = await Promise.all(
      hashes.map(async (hash) => {
        const count = await repository.git.run(['rev-list', '--count', hash]);
        return { hash, depth: Number(count.trim()) };
      }),
    );
    return dated.sort((a, b) => a.depth - b.depth).map((d) => d.hash);
  }

  private post(message: RebaseHostMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

function oldestOf(hashes: string[]): string {
  return hashes[0];
}
