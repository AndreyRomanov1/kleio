import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Ref, RepositorySnapshot } from '../../shared/model';
import { GitError } from '../git/gitRunner';
import type { Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import type { SyncActions } from './syncActions';
import { t } from '../../shared/l10n';

/** What git says when local changes would be lost by a checkout. */
const OVERWRITTEN = /would be overwritten by checkout|untracked working tree files would be overwritten/;

/** Git operations started from the UI: asks what is needed, runs git, reports the outcome. */
export class GitActions {
  constructor(
    private readonly repositories: RepositoryManager,
    private readonly sync: SyncActions,
  ) {}

  async checkoutRef(repository: Repository, snapshot: RepositorySnapshot, ref: Ref): Promise<void> {
    if (ref.kind !== 'tag' && (await this.redirectToMainWorktree(snapshot, ref))) return;
    if (ref.kind === 'remote') return this.checkoutRemote(repository, snapshot, ref);
    if (ref.kind === 'tag') return this.checkoutRevision(repository, ref.name);
    if (snapshot.head.branch === ref.name) return;
    const busy = snapshot.worktrees.find((w) => w.branch === ref.name && !w.isCurrent);
    if (busy) return this.offerWorktree(ref.name, busy.path);
    await this.run(repository, `Checkout ${ref.name}`, ['checkout', ref.name]);
  }

  /**
   * Switches to a remote branch. When a local branch of the same name has diverged — typically because the
   * branch was rebased on the server — offers to reset the local branch to the remote one.
   */
  private async checkoutRemote(
    repository: Repository,
    snapshot: RepositorySnapshot,
    remote: Ref,
  ): Promise<void> {
    const localName = remote.name.slice(remote.name.indexOf('/') + 1);
    const local = snapshot.refs.find((r) => r.kind === 'head' && r.name === localName);

    if (!local) {
      await this.run(repository, `Checkout ${remote.name}`, [
        'checkout',
        '-b',
        localName,
        '--track',
        remote.name,
      ]);
      return;
    }

    const busy = snapshot.worktrees.find((w) => w.branch === localName && !w.isCurrent);
    if (busy) return this.offerWorktree(localName, busy.path);

    const { ahead, behind } = await repository.aheadBehind(local.name, remote.name);
    if (ahead === 0) {
      const title =
        behind === 0
          ? `Checkout ${localName}`
          : t('Checkout {0} and pull {1} commit(s) from {2}', localName, behind, remote.name);
      await this.run(repository, title, ['checkout', '-B', localName, remote.name]);
      return;
    }

    const unique = await repository.uniqueCommits(remote.name, local.name);
    const detail =
      unique.length === 0
        ? t(
            'All {0} local commits are in {1} in another form (the branch was rebased): the reset loses nothing.',
            ahead,
            remote.name,
          )
        : t(
            '{0} of {1} local commits are not in {2}. After the reset they can be found only in the reflog.',
            unique.length,
            ahead,
            remote.name,
          );
    const reset = t('Reset to {0}', remote.name);
    const keep = t('Check out the local one');
    const choice = await vscode.window.showWarningMessage(
      t(
        'Local branch {0} has diverged from {1}: {2} own commits, {3} new ones on the remote.',
        localName,
        remote.name,
        ahead,
        behind,
      ),
      { modal: true, detail },
      reset,
      keep,
    );
    if (choice === reset) {
      await this.run(repository, `Checkout ${localName} = ${remote.name}`, [
        'checkout',
        '-B',
        localName,
        remote.name,
      ]);
    } else if (choice === keep && snapshot.head.branch !== localName) {
      await this.run(repository, `Checkout ${localName}`, ['checkout', localName]);
    }
  }

  /**
   * A linked worktree is kept for its own branch: switching it to an unrelated branch is offered to happen in
   * the main folder of the project instead. Returns true when the checkout was handled there.
   */
  private async redirectToMainWorktree(snapshot: RepositorySnapshot, ref: Ref): Promise<boolean> {
    const here = snapshot.worktrees.find((w) => w.isCurrent);
    const main = snapshot.worktrees.find((w) => w.isMain);
    if (!here || !main || here.isMain) return false;
    const target = ref.kind === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name;
    if (target === here.branch) return false;
    if (snapshot.worktrees.some((w) => w.branch === target && !w.isCurrent)) return false;

    const inMain = t('Check out in the main folder');
    const inHere = t('Check out in this worktree');
    const choice = await vscode.window.showInformationMessage(
      t(
        'This is the worktree of {0}. Check out {1} in the main folder of the project?',
        here.branch ?? t('(no branch)'),
        target,
      ),
      {
        modal: true,
        detail: t(
          'Main folder: {0}. The checkout runs there and it opens in this window; the worktree keeps its branch.',
          main.path,
        ),
      },
      inMain,
      inHere,
    );
    if (choice === inHere) return false;
    if (choice !== inMain) return true;

    const mainRepository = await this.repositories.get(main.path);
    if (!mainRepository) return true;
    const mainSnapshot = await mainRepository.snapshot({ revisions: ['HEAD'] });
    const mainRef = mainSnapshot.refs.find((r) => r.fullName === ref.fullName) ?? ref;
    const before = mainSnapshot.head.branch;
    await this.checkoutRef(mainRepository, mainSnapshot, mainRef);
    const after = (await mainRepository.head()).branch;
    if (after === target || before === target) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(main.path), {
        forceNewWindow: false,
      });
    }
    return true;
  }

  /**
   * Checks the branch out into a new worktree next to the main folder (`shop-PROJ-1234` by default), copies
   * the files the setting lists (local secrets and the like that git does not track) and opens it.
   */
  async checkoutToWorktree(repository: Repository, snapshot: RepositorySnapshot, ref: Ref): Promise<void> {
    if (ref.kind === 'tag') return;
    const branch = ref.kind === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name;
    const busy = snapshot.worktrees.find((w) => w.branch === branch);
    if (busy) return this.offerWorktree(branch, busy.path);
    const main = snapshot.worktrees.find((w) => w.isMain)?.path ?? repository.root;
    const config = vscode.workspace.getConfiguration('kleio');
    const template = config.get<string>('worktree.path', '${repoParent}/${repoName}-${branch}');
    const suggested = path.normalize(
      template
        .replace(/\$\{repoParent\}/g, path.dirname(main))
        .replace(/\$\{repoName\}/g, path.basename(main))
        .replace(/\$\{branch\}/g, branch.replace(/[\\/:*?"<>|\s]+/g, '-')),
    );
    const target = await vscode.window.showInputBox({
      title: t('Worktree for {0}', branch),
      prompt: t('Folder of the new worktree'),
      value: suggested,
      valueSelection: [suggested.length - path.basename(suggested).length, suggested.length],
      validateInput: (value) => (existsSync(value) ? t('This folder already exists') : undefined),
    });
    if (!target) return;
    const local = snapshot.refs.some((r) => r.kind === 'head' && r.name === branch);
    const args =
      ref.kind === 'remote' && !local
        ? ['worktree', 'add', '--track', '-b', branch, target, ref.name]
        : ['worktree', 'add', target, branch];
    if (!(await this.run(repository, `Worktree ${branch}`, args, true))) return;

    const copied: string[] = [];
    for (const file of config.get<string[]>('worktree.copyFiles', [])) {
      const from = path.join(main, file);
      const to = path.join(target, file);
      if (!existsSync(from) || existsSync(to)) continue;
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
      copied.push(file);
    }
    const newWindow = t('Open in a new window');
    const thisWindow = t('Open in this window');
    const choice = await vscode.window.showInformationMessage(
      copied.length
        ? t('Worktree {0} is created, copied: {1}.', path.basename(target), copied.join(', '))
        : t('Worktree {0} is created.', path.basename(target)),
      newWindow,
      thisWindow,
    );
    if (choice) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), {
        forceNewWindow: choice === newWindow,
      });
    }
  }

  /** A branch checked out in another worktree cannot be checked out here; its worktree can be opened instead. */
  private async offerWorktree(branch: string, worktreePath: string): Promise<void> {
    const newWindow = t('Open in a new window');
    const thisWindow = t('Open in this window');
    const choice = await vscode.window.showInformationMessage(
      t('Branch {0} is checked out in worktree {1}.', branch, worktreePath),
      {
        modal: true,
        detail: t('A branch cannot be checked out in two worktrees at once: work with it there.'),
      },
      newWindow,
      thisWindow,
    );
    if (!choice) return;
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), {
      forceNewWindow: choice === newWindow,
    });
  }

  async checkoutRevision(repository: Repository, revision: string): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      t('Check out {0} without a branch (detached HEAD)?', shorten(revision)),
      { modal: true },
      t('Check out'),
    );
    if (ok) await this.run(repository, `Checkout ${shorten(revision)}`, ['checkout', '--detach', revision]);
  }

  async createBranch(repository: Repository, startPoint: string, suggestedName = ''): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: t('New branch from {0}', shorten(startPoint)),
      value: suggestedName,
      prompt: t('Branch name'),
      validateInput: (value) => validateRefName(repository, 'branch', value),
    });
    if (!name) return;
    const checkout = t('Create and check out');
    const only = t('Create only');
    const choice = await vscode.window.showQuickPick([checkout, only], { title: t('Branch {0}', name) });
    if (!choice) return;
    const args = choice === checkout ? ['checkout', '-b', name, startPoint] : ['branch', name, startPoint];
    await this.run(repository, t('Branch {0}', name), args);
  }

  async createTag(repository: Repository, revision: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: t('New tag at {0}', shorten(revision)),
      prompt: t('Tag name'),
      validateInput: (value) => validateRefName(repository, 'tag', value),
    });
    if (name) await this.run(repository, t('Tag {0}', name), ['tag', name, revision]);
  }

  async deleteBranch(repository: Repository, snapshot: RepositorySnapshot, ref: Ref): Promise<void> {
    if (ref.kind !== 'head') return;
    if (snapshot.head.branch === ref.name) {
      void vscode.window.showWarningMessage(t('The current branch {0} cannot be deleted.', ref.name));
      return;
    }
    const worktree = snapshot.worktrees.find((w) => w.branch === ref.name && !w.isCurrent);
    if (worktree) {
      const removed = await this.removeWorktree(repository, ref.name, worktree.path);
      if (!removed) return;
    } else {
      const ok = await vscode.window.showWarningMessage(
        t('Delete local branch {0}?', ref.name),
        { modal: true },
        t('Delete'),
      );
      if (!ok) return;
    }
    try {
      await repository.git.run(['branch', '-d', ref.name]);
      this.repositories.notifyChanged(repository);
    } catch (error) {
      if (!(error instanceof GitError) || !error.stderr.includes('not fully merged'))
        return this.report(error);
      const force = await vscode.window.showWarningMessage(
        t('Branch {0} is not merged into any branch. Delete it anyway?', ref.name),
        { modal: true, detail: t('Its commits will be reachable only through the reflog.') },
        t('Delete'),
      );
      if (force) await this.run(repository, t('Deleting {0}', ref.name), ['branch', '-D', ref.name]);
    }
  }

  /** Removes the worktree a branch is checked out in, so that the branch itself can be deleted. */
  private async removeWorktree(
    repository: Repository,
    branch: string,
    worktreePath: string,
  ): Promise<boolean> {
    const ok = await vscode.window.showWarningMessage(
      t(
        'Branch {0} is checked out in worktree {1}. Delete the worktree and the branch?',
        branch,
        worktreePath,
      ),
      { modal: true, detail: t('Folder {0} will be deleted from the disk.', worktreePath) },
      t('Delete the worktree and the branch'),
    );
    if (!ok) return false;
    try {
      await repository.git.run(['worktree', 'remove', worktreePath]);
      return true;
    } catch (error) {
      if (!(error instanceof GitError) || !/modified or untracked|is dirty/.test(error.stderr)) {
        this.report(error);
        return false;
      }
    }
    const force = await vscode.window.showWarningMessage(
      t('Worktree {0} has uncommitted changes. Delete it with them?', worktreePath),
      { modal: true, detail: t('Changes and untracked files in this folder will be lost for good.') },
      t('Delete with the changes'),
    );
    if (!force) return false;
    try {
      await repository.git.run(['worktree', 'remove', '--force', worktreePath]);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  async deleteRemoteBranch(repository: Repository, ref: Ref): Promise<void> {
    if (ref.kind !== 'remote') return;
    const slash = ref.name.indexOf('/');
    const remote = ref.name.slice(0, slash);
    const branch = ref.name.slice(slash + 1);
    const ok = await vscode.window.showWarningMessage(
      t('Delete branch {0} on {1}?', branch, remote),
      {
        modal: true,
        detail: t(
          'Runs git push {0} --delete {1}. The branch disappears from the server for everyone; the local branch {1}, if any, stays.',
          remote,
          branch,
        ),
      },
      t('Delete on {0}', remote),
    );
    if (ok)
      await this.run(repository, t('Deleting {0}', ref.name), ['push', remote, '--delete', branch], true);
  }

  async revert(repository: Repository, hash: string, parents: string[]): Promise<void> {
    const args = ['revert', '--no-edit'];
    if (parents.length > 1) {
      const picked = await vscode.window.showQuickPick(
        parents.map((p, i) => ({ label: t('Parent {0}', i + 1), description: shorten(p), number: i + 1 })),
        { title: t('Merge commit: revert relative to which parent?') },
      );
      if (!picked) return;
      args.push('-m', String(picked.number));
    }
    await this.run(repository, `Revert ${shorten(hash)}`, [...args, hash]);
  }

  async fetch(repository: Repository, remoteBranch?: Ref): Promise<void> {
    if (remoteBranch?.kind === 'remote') {
      const slash = remoteBranch.name.indexOf('/');
      const remote = remoteBranch.name.slice(0, slash);
      const branch = remoteBranch.name.slice(slash + 1);
      await this.run(repository, `Fetch ${remoteBranch.name}`, ['fetch', remote, branch], true);
      return;
    }
    await this.run(repository, 'Fetch', ['fetch', '--all', '--prune'], true);
  }

  private async run(
    repository: Repository,
    title: string,
    args: string[],
    showProgress = false,
  ): Promise<boolean> {
    const task = async () => {
      await repository.git.run(args);
      this.repositories.notifyChanged(repository);
    };
    try {
      if (showProgress) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Kleio: ${title}` },
          task,
        );
      } else {
        await task();
      }
      vscode.window.setStatusBarMessage(t('Kleio: {0} — done', title), 3000);
      return true;
    } catch (error) {
      if (args[0] === 'checkout' && error instanceof GitError && OVERWRITTEN.test(error.stderr)) {
        return this.smartCheckout(repository, title, args);
      }
      this.report(error);
      return false;
    }
  }

  /**
   * Rider's smart checkout: local changes that the checkout would overwrite are stashed, the checkout is done,
   * and the changes are brought back on top of the new branch.
   */
  private async smartCheckout(repository: Repository, title: string, args: string[]): Promise<boolean> {
    const ok = await vscode.window.showWarningMessage(
      t('Local changes are in the way of the checkout.'),
      {
        modal: true,
        detail: t(
          'Smart checkout: the changes are stashed, the branch is checked out, and the changes come back on top of it. If they come back with conflicts, the stash stays in the list.',
        ),
      },
      'Smart checkout',
    );
    if (!ok) return false;
    try {
      await repository.git.run([
        'stash',
        'push',
        '--include-untracked',
        '-m',
        `kleio: smart checkout (${title})`,
      ]);
    } catch (error) {
      this.report(error);
      return false;
    }
    try {
      await repository.git.run(args);
    } catch (error) {
      await repository.git.run(['stash', 'pop']).catch(() => undefined);
      this.repositories.notifyChanged(repository);
      this.report(error);
      return false;
    }
    try {
      await repository.git.run(['stash', 'pop']);
      vscode.window.setStatusBarMessage(t('Kleio: {0} — the changes are carried over', title), 4000);
    } catch {
      void vscode.window.showWarningMessage(
        t(
          '{0}: the changes came back with conflicts. Resolve them; the stashed copy stays in the stash.',
          title,
        ),
      );
    }
    this.repositories.notifyChanged(repository);
    return true;
  }

  async renameBranch(repository: Repository, ref: Ref): Promise<void> {
    if (ref.kind !== 'head') return;
    const name = await vscode.window.showInputBox({
      title: t('Rename branch {0}', ref.name),
      value: ref.name,
      prompt: t('New name'),
      validateInput: (value) =>
        value === ref.name ? undefined : validateRefName(repository, 'branch', value),
    });
    if (!name || name === ref.name) return;
    await this.run(repository, t('Rename {0} → {1}', ref.name, name), ['branch', '-m', ref.name, name]);
  }

  /** Sets the remote branch a local one pulls from and pushes to, or unsets it. */
  async setUpstream(repository: Repository, snapshot: RepositorySnapshot, ref: Ref): Promise<void> {
    if (ref.kind !== 'head') return;
    const remotes = snapshot.refs
      .filter((r) => r.kind === 'remote' && !r.name.endsWith('/HEAD'))
      .sort(
        (a, b) => Number(sameBranch(b, ref)) - Number(sameBranch(a, ref)) || a.name.localeCompare(b.name),
      );
    const items: (vscode.QuickPickItem & { upstream?: string })[] = remotes.map((r) => ({
      label: r.name,
      description: r.fullName === ref.upstream ? t('current upstream') : undefined,
      upstream: r.name,
    }));
    if (ref.upstream) items.push({ label: t('$(close) Stop tracking'), upstream: undefined });
    const picked = await vscode.window.showQuickPick(items, { title: t('Upstream of {0}', ref.name) });
    if (!picked) return;
    if (picked.upstream) {
      await this.run(repository, t('{0} tracks {1}', ref.name, picked.upstream), [
        'branch',
        `--set-upstream-to=${picked.upstream}`,
        ref.name,
      ]);
    } else {
      await this.run(repository, t('{0} tracks nothing', ref.name), ['branch', '--unset-upstream', ref.name]);
    }
  }

  async pushTag(repository: Repository, ref: Ref): Promise<void> {
    if (ref.kind !== 'tag') return;
    const remote = await this.remote(repository);
    if (!remote) return;
    await this.run(
      repository,
      t('Push tag {0} to {1}', ref.name, remote),
      ['push', remote, `refs/tags/${ref.name}`],
      true,
    );
  }

  async deleteTag(repository: Repository, ref: Ref): Promise<void> {
    if (ref.kind !== 'tag') return;
    const remote = await this.remote(repository);
    const local = t('Delete locally');
    const everywhere = remote ? t('Delete locally and on {0}', remote) : undefined;
    const choice = await vscode.window.showWarningMessage(
      t('Delete tag {0}?', ref.name),
      { modal: true },
      local,
      ...(everywhere ? [everywhere] : []),
    );
    if (!choice) return;
    if (!(await this.run(repository, t('Delete tag {0}', ref.name), ['tag', '-d', ref.name]))) return;
    if (choice === everywhere && remote)
      await this.run(
        repository,
        t('Delete tag {0} on {1}', ref.name, remote),
        ['push', remote, `:refs/tags/${ref.name}`],
        true,
      );
  }

  /** The remote to push tags to: origin, or the only one, or the one the user picks. */
  private async remote(repository: Repository): Promise<string | undefined> {
    const remotes = (await repository.git.run(['remote'])).split('\n').filter(Boolean);
    if (remotes.includes('origin') || remotes.length <= 1)
      return remotes.includes('origin') ? 'origin' : remotes[0];
    return vscode.window.showQuickPick(remotes, { title: t('Remote repository') });
  }

  /** Rider's "Checkout and Rebase onto Current": the branch is checked out and rebased onto the current one. */
  async checkoutAndRebase(repository: Repository, snapshot: RepositorySnapshot, ref: Ref): Promise<void> {
    const current = snapshot.head.branch;
    if (ref.kind !== 'head' || !current || current === ref.name) return;
    const busy = snapshot.worktrees.find((w) => w.branch === ref.name && !w.isCurrent);
    if (busy) return this.offerWorktree(ref.name, busy.path);
    await this.sync.rebase(repository, snapshot, current, ref.name);
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Git: ${message}`);
  }
}

/** Whether a remote branch has the name of a local one, e.g. origin/feature for feature. */
function sameBranch(remote: Ref, local: Ref): boolean {
  return remote.name.slice(remote.name.indexOf('/') + 1) === local.name;
}

function shorten(revision: string): string {
  return /^[0-9a-f]{40,64}$/.test(revision) ? revision.slice(0, 8) : revision;
}

async function validateRefName(
  repository: Repository,
  kind: 'branch' | 'tag',
  value: string,
): Promise<string | undefined> {
  if (!value.trim()) return t('The name cannot be empty');
  const prefix = kind === 'branch' ? 'refs/heads/' : 'refs/tags/';
  try {
    await repository.git.run(['check-ref-format', `${prefix}${value}`]);
  } catch {
    return t('Not a valid git name');
  }
  const exists = await repository.revParse(`${prefix}${value}`);
  return exists ? t('This name is taken') : undefined;
}
