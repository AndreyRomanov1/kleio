import * as vscode from 'vscode';
import type { OperationKind, Ref, RepositorySnapshot } from '../../shared/model';
import type { RebaseEntry } from '../../shared/rebaseProtocol';
import type { OperationOutcome, Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import { withCancellableProgress } from '../progress';
import { t } from '../../shared/l10n';

const operationNames: Record<OperationKind, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
};

/** Merge, rebase, cherry-pick and updates from the remote; a stop for conflicts is reported, not an error. */
export class SyncActions {
  /** Opens the list of conflicts; set by the conflicts window. */
  showConflicts?: (repository: Repository) => Promise<void>;

  constructor(private readonly repositories: RepositoryManager) {}

  async merge(repository: Repository, snapshot: RepositorySnapshot, ref: Ref): Promise<void> {
    const current = snapshot.head.branch;
    if (!current) return this.detached();
    await this.operation(repository, `Merge ${ref.name} → ${current}`, 'merge', () =>
      repository.merge(ref.name),
    );
  }

  /** Rebases the current branch, or `branch` after checking it out, onto a revision. */
  async rebase(
    repository: Repository,
    snapshot: RepositorySnapshot,
    onto: string,
    branch?: string,
  ): Promise<void> {
    const current = branch ?? snapshot.head.branch;
    if (!current) return this.detached();
    await this.operation(repository, t('Rebase {0} onto {1}', current, shorten(onto)), 'rebase', () =>
      repository.rebase(onto, branch, { updateRefs: updateRefs() }),
    );
  }

  async interactiveRebase(
    repository: Repository,
    base: string | undefined,
    entries: RebaseEntry[],
    branch: string,
  ): Promise<void> {
    await this.operation(repository, `Interactive rebase ${branch}`, 'rebase', () =>
      repository.interactiveRebase(base, entries, { updateRefs: updateRefs() }),
    );
  }

  async cherryPick(repository: Repository, ...hashes: string[]): Promise<void> {
    const title =
      hashes.length === 1 ? `Cherry-pick ${shorten(hashes[0])}` : t('Cherry-pick {0} commits', hashes.length);
    await this.operation(repository, title, 'cherry-pick', () => repository.cherryPick(...hashes));
  }

  /** A button of the bar of a stopped operation; false when there is no operation any more. */
  async operationAction(
    repository: Repository,
    action: 'continue' | 'skip' | 'abort' | 'resolve',
  ): Promise<boolean> {
    const state = await repository.operation();
    if (!state) return false;
    switch (action) {
      case 'continue':
        await this.continueOperation(repository, state.kind);
        break;
      case 'skip':
        await this.skip(repository, state.kind);
        break;
      case 'abort':
        await this.abort(repository, state.kind);
        break;
      case 'resolve':
        if (this.showConflicts) await this.showConflicts(repository);
        else await vscode.commands.executeCommand('kleio.commit.focus');
        break;
    }
    return true;
  }

  async revert(repository: Repository, hash: string, mainline?: number): Promise<void> {
    await this.operation(repository, `Revert ${shorten(hash)}`, 'revert', () =>
      repository.revert(hash, mainline),
    );
  }

  async continueOperation(repository: Repository, kind: OperationKind): Promise<void> {
    await this.operation(repository, t('{0}: continue', operationNames[kind]), kind, () =>
      repository.continueOperation(kind),
    );
  }

  async skip(repository: Repository, kind: OperationKind): Promise<void> {
    await this.operation(repository, t('{0}: skip the commit', operationNames[kind]), kind, () =>
      repository.skipOperation(kind),
    );
  }

  async abort(repository: Repository, kind: OperationKind): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      t('Abort {0}?', operationNames[kind].toLowerCase()),
      {
        modal: true,
        detail: t(
          'The branch returns to where it was before the operation; resolved conflicts are lost. Uncommitted changes stashed for the operation come back.',
        ),
      },
      t('Abort'),
    );
    if (!ok) return;
    try {
      await repository.abortOperation(kind);
      vscode.window.setStatusBarMessage(t('Kleio: {0} aborted', operationNames[kind]), 4000);
    } catch (error) {
      report(error);
    } finally {
      this.repositories.notifyChanged(repository);
    }
  }

  /**
   * Rider's Update Project: fetches every remote and brings the current branch up to date with its
   * upstream — fast-forward when it has no own commits, otherwise rebase or merge as configured.
   */
  async updateProject(repository: Repository): Promise<void> {
    const fetched = await this.fetchWithProgress(
      t('Kleio: updating the project'),
      async (signal, progress) => {
        progress.report({ message: 'fetch' });
        await repository.git.run(['fetch', '--all', '--prune'], { signal });
        return true;
      },
    );
    this.repositories.notifyChanged(repository);
    if (!fetched) return;

    const head = await repository.head();
    if (!head.branch) {
      void vscode.window.showInformationMessage(
        t('Fetched. HEAD has no branch, so there is nothing to update.'),
      );
      return;
    }
    const upstream = await this.upstream(repository, head.branch);
    if (!upstream) {
      void vscode.window.showInformationMessage(
        t('Fetched. Branch {0} has no upstream, so there is nothing to pull from.', head.branch),
      );
      return;
    }
    const { ahead, behind } = await repository.aheadBehind(head.branch, upstream);
    if (behind === 0) {
      vscode.window.setStatusBarMessage(t('Kleio: {0} is up to date', head.branch), 4000);
      return;
    }
    const title = t('Updating {0} from {1}: {2} new', head.branch, upstream, behind);
    if (ahead === 0) {
      await this.operation(repository, title, 'merge', () =>
        repository.merge(upstream, { fastForwardOnly: true }),
      );
      return;
    }
    const method = await this.updateMethod(repository, head.branch, upstream, ahead, behind);
    if (!method) return;
    if (method === 'merge') {
      await this.operation(repository, title, 'merge', () => repository.merge(upstream));
    } else {
      await this.operation(repository, title, 'rebase', () =>
        repository.rebase(upstream, undefined, { updateRefs: updateRefs() }),
      );
    }
  }

  /**
   * Brings a local branch up to its upstream without checking it out — only when the branch has no commits
   * of its own, so nothing can be lost. The current branch is updated as the whole project.
   */
  async updateBranch(repository: Repository, snapshot: RepositorySnapshot, ref: Ref): Promise<void> {
    if (ref.kind !== 'head') return;
    if (snapshot.head.branch === ref.name) return this.updateProject(repository);
    const upstreamRef = snapshot.refs.find((r) => r.fullName === ref.upstream);
    if (!ref.upstream || !upstreamRef) {
      void vscode.window.showInformationMessage(t('Branch {0} has no upstream to update from.', ref.name));
      return;
    }
    const worktree = snapshot.worktrees.find((w) => w.branch === ref.name);
    if (worktree) {
      void vscode.window.showInformationMessage(
        t('Branch {0} is checked out in worktree {1}: update it there.', ref.name, worktree.path),
      );
      return;
    }
    // A branch may track another local branch (`branch.<name>.remote = .`): nothing to fetch then.
    if (upstreamRef.kind === 'remote') {
      const slash = upstreamRef.name.indexOf('/');
      const remote = upstreamRef.name.slice(0, slash);
      const remoteBranch = upstreamRef.name.slice(slash + 1);
      const fetched = await this.fetchWithProgress(`Kleio: fetch ${upstreamRef.name}`, async (signal) => {
        await repository.git.run(['fetch', remote, remoteBranch], { signal });
        return true;
      });
      if (!fetched) return;
    }
    const [local, upstream] = await Promise.all([
      repository.revParse(ref.fullName),
      repository.revParse(upstreamRef.fullName),
    ]);
    if (!local || !upstream) return;
    const { ahead, behind } = await repository.aheadBehind(local, upstream);
    if (behind === 0) {
      vscode.window.setStatusBarMessage(t('Kleio: {0} is up to date', ref.name), 4000);
    } else if (ahead > 0) {
      void vscode.window.showWarningMessage(
        t(
          'Branch {0} has diverged from {1}: {2} own commits, {3} new. Without a checkout it can be updated only when it has no own commits: check it out and update the project.',
          ref.name,
          upstreamRef.name,
          ahead,
          behind,
        ),
      );
    } else {
      try {
        await repository.moveBranch(ref.name, upstream, local);
        vscode.window.setStatusBarMessage(
          t('Kleio: {0} +{1} from {2}', ref.name, behind, upstreamRef.name),
          4000,
        );
      } catch (error) {
        report(error);
      }
    }
    this.repositories.notifyChanged(repository);
  }

  async reset(repository: Repository, snapshot: RepositorySnapshot, hash: string): Promise<void> {
    const branch = snapshot.head.branch ?? 'HEAD';
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: 'Soft',
          mode: 'soft' as const,
          detail: t('Changes of the later commits stay in the index'),
        },
        {
          label: 'Mixed',
          mode: 'mixed' as const,
          detail: t('Changes stay in the working tree, the index is cleared'),
        },
        {
          label: 'Hard',
          mode: 'hard' as const,
          detail: t('Changes of the commits and uncommitted changes are lost'),
        },
      ],
      { title: t('Reset {0} to {1}', branch, shorten(hash)) },
    );
    if (!picked) return;
    if (picked.mode === 'hard') {
      const ok = await vscode.window.showWarningMessage(
        t('Hard reset {0} to {1}?', branch, shorten(hash)),
        {
          modal: true,
          detail: t(
            'Uncommitted changes of tracked files are lost for good; the commits stay in the reflog.',
          ),
        },
        'Hard reset',
      );
      if (!ok) return;
    }
    try {
      await repository.reset(hash, picked.mode);
      vscode.window.setStatusBarMessage(t('Kleio: reset {0} to {1}', branch, shorten(hash)), 4000);
    } catch (error) {
      report(error);
    } finally {
      this.repositories.notifyChanged(repository);
    }
  }

  /**
   * Undo through the reflog: the latest states of HEAD, and the branch is moved back to the chosen one with
   * `reset --keep`, which keeps uncommitted changes and refuses when they are in the way.
   */
  async undo(repository: Repository): Promise<void> {
    const [head, state] = await Promise.all([repository.head(), repository.operation()]);
    const entries = await repository.reflog(head.branch);
    if (state) {
      void vscode.window.showWarningMessage(t('Finish or abort the {0} first.', operationNames[state.kind]));
      return;
    }
    if (entries.length < 2) {
      void vscode.window.showInformationMessage(t('The reflog has nothing to return to yet.'));
      return;
    }
    const now = Date.now() / 1000;
    const items = entries.slice(1).map((entry, i) => ({
      label: t('Before: {0}', entries[i].action),
      description: `${shorten(entry.hash)} · ${ago(now - entry.date)}`,
      detail: entry.subject,
      entry,
    }));
    const branch = head.branch ?? 'HEAD';
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Return {0} to an earlier state', branch),
      placeHolder: t('The latest actions first; the reflog keeps every state'),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    const ok = await vscode.window.showWarningMessage(
      t('Return {0} to {1}?', branch, shorten(picked.entry.hash)),
      {
        modal: true,
        detail: t(
          'Runs git reset --keep. Commits made after that stay in the reflog, so this can be undone the same way. Uncommitted changes are kept; if they are in the way, git refuses.',
        ),
      },
      t('Return'),
    );
    if (!ok) return;
    try {
      await repository.reset(picked.entry.hash, 'keep');
      vscode.window.setStatusBarMessage(
        t('Kleio: {0} returned to {1}', branch, shorten(picked.entry.hash)),
        4000,
      );
    } catch (error) {
      report(error);
    } finally {
      this.repositories.notifyChanged(repository);
    }
  }

  private async operation(
    repository: Repository,
    title: string,
    kind: OperationKind,
    run: () => Promise<OperationOutcome>,
  ): Promise<void> {
    const outcome = await this.withProgress(`Kleio: ${title}`, run);
    this.repositories.notifyChanged(repository);
    if (outcome === undefined) return;
    if (outcome === 'done') {
      vscode.window.setStatusBarMessage(t('Kleio: {0} — done', title), 4000);
      return;
    }
    if (outcome === 'stash-conflicts') {
      const resolve = t('Resolve conflicts');
      const choice = await vscode.window.showWarningMessage(
        t('{0}: done, but uncommitted changes came back with conflicts.', title),
        {
          detail: t(
            'The changes were stashed for the operation. Their copy stays in the stash; drop it once the conflicts are resolved.',
          ),
        },
        resolve,
      );
      if (choice === resolve) await this.showConflicts?.(repository);
      return;
    }
    const state = await repository.operation();
    const name = operationNames[state?.kind ?? kind];
    if (outcome === 'stopped') {
      void vscode.window.showInformationMessage(
        state?.stoppedAt
          ? t(
              '{0} stopped at {1}: make the changes and press Continue in the log.',
              name,
              shorten(state.stoppedAt),
            )
          : t('{0} stopped: make the changes and press Continue in the log.', name),
      );
      return;
    }
    if (this.showConflicts) {
      await this.showConflicts(repository);
      return;
    }
    const files = state?.conflicted ?? [];
    const abort = t('Abort');
    const choice = await vscode.window.showWarningMessage(
      t('{0}: conflicts in {1} file(s)', name, files.length),
      { detail: files.slice(0, 10).join('\n') },
      abort,
    );
    if (choice === abort && state) await this.abort(repository, state.kind);
  }

  /**
   * The way to update a diverged branch: the Kleio setting, else what git pull would do by the git config
   * (`branch.<name>.rebase`, `pull.rebase`, `pull.ff=only`), else asked once and saved in the user settings.
   */
  private async updateMethod(
    repository: Repository,
    branch: string,
    upstream: string,
    ahead: number,
    behind: number,
  ): Promise<'merge' | 'rebase' | undefined> {
    const config = vscode.workspace.getConfiguration('kleio');
    const method = config.get<'ask' | 'merge' | 'rebase'>('update.method', 'ask');
    if (method !== 'ask') return method;
    const fromGit = await gitPullMethod(repository, branch);
    if (fromGit === 'ff-only') {
      void vscode.window.showWarningMessage(
        t(
          'Branch {0} has diverged from {1}: {2} own commits, {3} new. The git config allows only fast-forward (pull.ff=only), as git pull does.',
          branch,
          upstream,
          ahead,
          behind,
        ),
      );
      return undefined;
    }
    if (fromGit) return fromGit;
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: 'Merge',
          method: 'merge' as const,
          detail: t('Merge {0} into {1} with a merge commit, as git pull does', upstream, branch),
        },
        {
          label: 'Rebase',
          method: 'rebase' as const,
          detail: t(
            'Move own commits on top of {0}, as git pull --rebase does; the history stays linear, but the commits get new hashes',
            upstream,
          ),
        },
      ],
      {
        title: t(
          '{0}: {1} own commits, {2} new in {3}. How to update branches that diverged from their upstream?',
          branch,
          ahead,
          behind,
          upstream,
        ),
        placeHolder: t('The choice is saved in the kleio.update.method setting'),
        ignoreFocusOut: true,
      },
    );
    if (!picked) return undefined;
    await config.update('update.method', picked.method, vscode.ConfigurationTarget.Global);
    return picked.method;
  }

  private async upstream(repository: Repository, branch: string): Promise<string | undefined> {
    const output = await repository.git.run(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`],
      { allowExitCodes: [128] },
    );
    return output.trim() || undefined;
  }

  private async fetchWithProgress<T>(
    title: string,
    task: (signal: AbortSignal, progress: vscode.Progress<{ message?: string }>) => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await withCancellableProgress(title, task);
    } catch (error) {
      report(error);
      return undefined;
    }
  }

  private async withProgress<T>(
    title: string,
    task: (progress: vscode.Progress<{ message?: string }>) => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title },
        task,
      );
    } catch (error) {
      report(error);
      return undefined;
    }
  }

  private detached(): void {
    void vscode.window.showWarningMessage(t('HEAD has no branch: check out a branch first.'));
  }
}

/** What `git pull` would do with a diverged branch by the git config; undefined when nothing is set. */
async function gitPullMethod(
  repository: Repository,
  branch: string,
): Promise<'merge' | 'rebase' | 'ff-only' | undefined> {
  const get = async (key: string) =>
    (await repository.git.run(['config', '--get', key], { allowExitCodes: [1] })).trim().toLowerCase();
  const rebase = (await get(`branch.${branch}.rebase`)) || (await get('pull.rebase'));
  if (rebase) return ['false', 'no', 'off', '0'].includes(rebase) ? 'merge' : 'rebase';
  return (await get('pull.ff')) === 'only' ? 'ff-only' : undefined;
}

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`Git: ${message}`);
}

/** A rough age: minutes, hours or days. */
function ago(seconds: number): string {
  if (seconds < 3600) return t('{0} min ago', Math.max(1, Math.round(seconds / 60)));
  if (seconds < 86400) return t('{0} h ago', Math.round(seconds / 3600));
  return t('{0} d ago', Math.round(seconds / 86400));
}

function shorten(revision: string): string {
  return /^[0-9a-f]{40,64}$/.test(revision) ? revision.slice(0, 8) : revision;
}

/** Whether a rebase moves the branches stacked on the rebased commits along with them. */
export function updateRefs(): boolean {
  return vscode.workspace.getConfiguration('kleio').get<boolean>('rebase.updateRefs', true);
}
