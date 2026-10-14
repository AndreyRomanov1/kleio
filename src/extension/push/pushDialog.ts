import * as vscode from 'vscode';
import type {
  PushBranchView,
  PushHostMessage,
  PushRequest,
  PushWebviewMessage,
} from '../../shared/pushProtocol';
import { commitChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import { GitError } from '../git/gitRunner';
import type { Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import { renderHtml, webviewOptions } from '../webviewHtml';
import { matchesBranchPattern, pushArgs, readPushState } from './pushState';

const PANEL_TYPE = 'grove.push';
const PUSH_TIMEOUT_MS = 120_000;

/**
 * Rider's push dialog: outgoing commits of the current branch (and of other branches that have some),
 * with their files and diffs; force only as force-with-lease and never into protected branches.
 */
export class PushDialog implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private repository?: Repository;
  private focusBranch?: string;
  private branches: PushBranchView[] = [];
  /** Commit each remote branch pointed at when the dialog was filled: the lease of a forced push. */
  private leases = new Map<string, string | undefined>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repositories: RepositoryManager,
    private readonly navigator: ChangeSetNavigator,
  ) {}

  async open(repository: Repository, branch?: string): Promise<void> {
    this.repository = repository;
    this.focusBranch = branch;
    if (this.panel) {
      this.panel.reveal();
      await this.load();
      return;
    }
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, 'Push', vscode.ViewColumn.Active, {
      ...webviewOptions(this.context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.webview.html = renderHtml(panel.webview, this.context.extensionUri, 'push');
    panel.webview.onDidReceiveMessage((message: PushWebviewMessage) => void this.handle(message));
    panel.onDidDispose(() => (this.panel = undefined));
    this.panel = panel;
  }

  private async handle(message: PushWebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          return await this.load();
        case 'selectCommit': {
          const repository = this.repository;
          if (!repository) return;
          const details = await repository.commitDetails(message.hash);
          const changeSet = await commitChangeSet(repository, message.hash, details.parents);
          this.post({ type: 'files', hash: message.hash, files: changeSet.files });
          return;
        }
        case 'openFile': {
          const repository = this.repository;
          if (!repository) return;
          const details = await repository.commitDetails(message.hash);
          const changeSet = await commitChangeSet(repository, message.hash, details.parents);
          return await this.navigator.open(changeSet, message.index, 'first', {
            viewColumn: vscode.ViewColumn.Beside,
          });
        }
        case 'push':
          return await this.push(message.branches);
        case 'cancel':
          this.panel?.dispose();
          return;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.post({ type: 'error', message: text });
    }
  }

  private async load(): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    const state = await readPushState(repository, this.focusBranch, isProtected);
    if (state.remotes.length === 0) {
      this.post({ type: 'error', message: 'У репозитория нет remote — пушить некуда.' });
      return;
    }
    this.branches = state.branches;
    this.leases = state.leases;
    this.post({ type: 'state', remotes: state.remotes, branches: state.branches });
  }

  private async push(requests: PushRequest[]): Promise<void> {
    const repository = this.repository;
    if (!repository || requests.length === 0) return;
    for (const request of requests) {
      if (request.force && isProtected(request.target)) {
        this.post({
          type: 'error',
          message: `Force push в ${request.target} запрещён настройкой grove.push.protectedBranches.`,
        });
        return;
      }
    }
    this.post({ type: 'busy', value: true });
    const messages: string[] = [];
    try {
      for (const request of requests) {
        const output = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Grove: push ${request.branch} → ${request.remote}/${request.target}`,
          },
          () => repository.git.runWithOutput(this.pushArgs(request), { timeoutMs: PUSH_TIMEOUT_MS }),
        );
        messages.push(...remoteMessages(output.stderr));
      }
    } catch (error) {
      this.post({ type: 'error', message: explain(error) });
      await this.load();
      return;
    } finally {
      this.post({ type: 'busy', value: false });
      this.repositories.notifyChanged(repository);
    }
    this.panel?.dispose();
    await this.reportRemoteMessages(requests, messages);
  }

  private pushArgs(request: PushRequest): string[] {
    const branch = this.branches.find((b) => b.branch === request.branch);
    return pushArgs(request, !branch?.hasUpstream, this.leases.get(`${request.remote}/${request.target}`));
  }

  /** GitLab answers a push with a link to create or view a merge request; it is offered to open. */
  private async reportRemoteMessages(requests: PushRequest[], messages: string[]): Promise<void> {
    const summary = requests.map((r) => r.branch).join(', ');
    const url = messages.map((m) => /https?:\/\/\S+/.exec(m)?.[0]).find((u) => u !== undefined);
    if (!url) {
      vscode.window.setStatusBarMessage(`Grove: push ${summary} — готово`, 5000);
      return;
    }
    const open = /merge_requests\/new/.test(url) ? 'Создать MR' : 'Открыть ссылку';
    const choice = await vscode.window.showInformationMessage(
      `Push ${summary} — готово. ${messages.join(' ')}`,
      open,
    );
    if (choice) await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private post(message: PushHostMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

export function isProtected(branch: string): boolean {
  const patterns = vscode.workspace
    .getConfiguration('grove')
    .get<string[]>('push.protectedBranches', ['master', 'main']);
  return matchesBranchPattern(patterns, branch);
}

/** Lines the server printed with the `remote:` prefix, without empty ones. */
function remoteMessages(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('remote:'))
    .map((line) => line.slice('remote:'.length).trim())
    .filter(Boolean);
}

function explain(error: unknown): string {
  if (!(error instanceof GitError)) return error instanceof Error ? error.message : String(error);
  const text = error.stderr;
  if (/stale info/.test(text))
    return 'Отклонено: ветку на сервере обновили после того, как открылся этот диалог (force-with-lease). Обновите и посмотрите, что пришло.';
  if (/non-fast-forward|fetch first|\[rejected\]/.test(text))
    return 'Отклонено: на сервере есть коммиты, которых нет локально. Обновите ветку или, если она перебазирована, включите force-with-lease.';
  if (/protected branch|pre-receive hook declined/.test(text)) return `Сервер отклонил push: ${text.trim()}`;
  return text.trim() || error.message;
}
