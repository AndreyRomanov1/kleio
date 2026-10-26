import * as vscode from 'vscode';
import type { Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import type { HostingService } from '../hosting/hostingService';
import { t } from '../../shared/l10n';

export type RemoteAction = 'add' | 'manage' | 'fetch' | 'setUrl' | 'rename' | 'remove' | 'hosting';

const FETCH_TIMEOUT_MS = 120_000;

/**
 * Remotes of a repository, as Rider's Manage Remotes and the Git extension's remote commands: add, change the
 * URL, rename, remove, fetch one, and choose the one whose hosting the log shows. Plain `git remote` underneath.
 */
export class RemoteActions implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly repositories: RepositoryManager,
    private readonly hosting: HostingService,
  ) {
    this.disposables = [
      vscode.commands.registerCommand('kleio.remotes.manage', async () => {
        const repository = this.repositories.current;
        if (repository) await this.manage(repository);
      }),
    ];
  }

  async run(repository: Repository, action: RemoteAction, remote?: string): Promise<void> {
    if (action === 'add') return this.add(repository);
    if (action === 'manage') return this.manage(repository);
    if (!remote) return;
    switch (action) {
      case 'fetch':
        return this.fetch(repository, remote);
      case 'setUrl':
        return this.setUrl(repository, remote);
      case 'rename':
        return this.rename(repository, remote);
      case 'remove':
        return this.remove(repository, remote);
      case 'hosting':
        return this.hosting.setRemote(repository, remote);
    }
  }

  /** The list of remotes with their URLs, then what to do with the one chosen. */
  async manage(repository: Repository): Promise<void> {
    const [remotes, hosting] = await Promise.all([
      this.hosting.remotes(repository),
      this.hosting.known(repository),
    ]);
    const add = { label: `$(add) ${t('Add remote…')}`, remote: undefined as string | undefined };
    const items = [
      ...(await Promise.all(
        remotes.map(async (name) => ({
          label: name,
          description: await this.url(repository, name),
          detail: name === hosting?.remoteName ? t('The log shows the hosting of this remote') : undefined,
          remote: name as string | undefined,
        })),
      )),
      add,
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Remotes of {0}', repository.name),
      placeHolder: t('Choose a remote to change, or add one'),
    });
    if (!picked) return;
    if (!picked.remote) return this.add(repository);
    const remote = picked.remote;
    const actions: { label: string; action: RemoteAction }[] = [
      { label: '$(cloud-download) Fetch', action: 'fetch' },
      { label: `$(edit) ${t('Change URL…')}`, action: 'setUrl' },
      { label: `$(symbol-text) ${t('Rename…')}`, action: 'rename' },
      ...(remote === hosting?.remoteName
        ? []
        : [{ label: `$(globe) ${t('Show the hosting of this remote')}`, action: 'hosting' as const }]),
      { label: `$(trash) ${t('Remove remote…')}`, action: 'remove' },
    ];
    const action = await vscode.window.showQuickPick(actions, { title: remote });
    if (action) await this.run(repository, action.action, remote);
  }

  private async add(repository: Repository): Promise<void> {
    const remotes = await this.hosting.remotes(repository);
    const name = await vscode.window.showInputBox({
      title: t('Add remote'),
      prompt: t('Name of the remote, e.g. upstream or github'),
      value: remotes.includes('origin') ? '' : 'origin',
      validateInput: (value) => this.validateName(value.trim(), remotes),
    });
    if (!name?.trim()) return;
    const url = await vscode.window.showInputBox({
      title: t('Add remote {0}', name.trim()),
      prompt: t('URL of the repository, e.g. git@github.com:owner/project.git'),
      validateInput: (value) => (value.trim() ? undefined : t('The URL is empty')),
      ignoreFocusOut: true,
    });
    if (!url?.trim()) return;
    if (await this.git(repository, ['remote', 'add', name.trim(), url.trim()]))
      await this.fetch(repository, name.trim());
  }

  private async setUrl(repository: Repository, remote: string): Promise<void> {
    const current = await this.url(repository, remote);
    const url = await vscode.window.showInputBox({
      title: t('URL of {0}', remote),
      value: current,
      validateInput: (value) => (value.trim() ? undefined : t('The URL is empty')),
      ignoreFocusOut: true,
    });
    if (!url?.trim() || url.trim() === current) return;
    if (await this.git(repository, ['remote', 'set-url', remote, url.trim()]))
      await this.hosting.remoteChanged(repository, remote, remote);
  }

  /** Git moves the upstreams of the branches along; Kleio's choice of the hosting remote follows too. */
  private async rename(repository: Repository, remote: string): Promise<void> {
    const remotes = await this.hosting.remotes(repository);
    const name = await vscode.window.showInputBox({
      title: t('Rename remote {0}', remote),
      value: remote,
      validateInput: (value) =>
        value.trim() === remote ? undefined : this.validateName(value.trim(), remotes),
    });
    if (!name?.trim() || name.trim() === remote) return;
    await this.renameRemote(repository, remote, name.trim());
  }

  async renameRemote(repository: Repository, remote: string, name: string): Promise<void> {
    if (await this.git(repository, ['remote', 'rename', remote, name]))
      await this.hosting.remoteChanged(repository, remote, name);
  }

  async removeRemote(repository: Repository, remote: string): Promise<void> {
    if (await this.git(repository, ['remote', 'remove', remote]))
      await this.hosting.remoteChanged(repository, remote, undefined);
  }

  /** Only after a confirmation that says what goes: the remote branches here; nothing on the server. */
  private async remove(repository: Repository, remote: string): Promise<void> {
    const refs = await repository.refs();
    const tracking = refs
      .filter((r) => r.kind === 'head' && r.upstream?.startsWith(`refs/remotes/${remote}/`))
      .map((r) => r.name);
    const branches = refs.filter((r) => r.kind === 'remote' && r.name.startsWith(`${remote}/`)).length;
    const detail = [
      t(
        'The {0} branches of {1} disappear from the log. Nothing is deleted on the server.',
        branches,
        remote,
      ),
      ...(tracking.length ? [t('These local branches stop tracking it: {0}.', tracking.join(', '))] : []),
    ].join('\n');
    const remove = t('Remove');
    const choice = await vscode.window.showWarningMessage(
      t('Remove remote {0} ({1})?', remote, await this.url(repository, remote)),
      { modal: true, detail },
      remove,
    );
    if (choice !== remove) return;
    await this.removeRemote(repository, remote);
  }

  private async fetch(repository: Repository, remote: string): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Kleio: fetch {0}', remote) },
      () => this.git(repository, ['fetch', '--prune', remote], FETCH_TIMEOUT_MS),
    );
  }

  private validateName(name: string, remotes: string[]): string | undefined {
    if (!name) return t('The name is empty');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.endsWith('.lock'))
      return t('Letters, digits, dots, dashes and underscores only');
    if (remotes.includes(name)) return t('Remote {0} already exists', name);
    return undefined;
  }

  private async url(repository: Repository, remote: string): Promise<string> {
    return (await repository.git.run(['remote', 'get-url', remote], { allowExitCodes: [2, 128] })).trim();
  }

  /** Runs git and refreshes the log; a failure is shown as git told it. */
  private async git(repository: Repository, args: string[], timeoutMs?: number): Promise<boolean> {
    try {
      await repository.git.run(args, timeoutMs ? { timeoutMs } : {});
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.repositories.notifyChanged(repository);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
