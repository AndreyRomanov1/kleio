import * as vscode from 'vscode';
import type { Ref, RepositorySnapshot } from '../../shared/model';
import { GitError } from '../git/gitRunner';
import type { Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';

/** Git operations started from the UI: asks what is needed, runs git, reports the outcome. */
export class GitActions {
  constructor(private readonly repositories: RepositoryManager) {}

  async checkoutRef(repository: Repository, snapshot: RepositorySnapshot, ref: Ref): Promise<void> {
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
          : `Checkout ${localName} и подтянуть ${behind} коммит(ов) из ${remote.name}`;
      await this.run(repository, title, ['checkout', '-B', localName, remote.name]);
      return;
    }

    const unique = await repository.uniqueCommits(remote.name, local.name);
    const detail =
      unique.length === 0
        ? `Все ${ahead} локальных коммитов есть в ${remote.name} в другом виде (ветку перебазировали) — сброс ничего не потеряет.`
        : `${unique.length} из ${ahead} локальных коммитов нет в ${remote.name}. После сброса их можно найти только через reflog.`;
    const reset = 'Сбросить на ' + remote.name;
    const keep = 'Переключиться на локальную';
    const choice = await vscode.window.showWarningMessage(
      `Локальная ветка ${localName} разошлась с ${remote.name}: ${ahead} своих, ${behind} новых в origin.`,
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

  /** A branch checked out in another worktree cannot be checked out here; its worktree can be opened instead. */
  private async offerWorktree(branch: string, worktreePath: string): Promise<void> {
    const newWindow = 'Открыть в новом окне';
    const thisWindow = 'Открыть в этом окне';
    const choice = await vscode.window.showInformationMessage(
      `Ветка ${branch} открыта в worktree ${worktreePath}.`,
      {
        modal: true,
        detail: 'Одна ветка не может быть выбрана в двух worktree сразу — работать с ней нужно там.',
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
      `Переключиться на ${shorten(revision)} без ветки (detached HEAD)?`,
      { modal: true },
      'Переключиться',
    );
    if (ok) await this.run(repository, `Checkout ${shorten(revision)}`, ['checkout', '--detach', revision]);
  }

  async createBranch(repository: Repository, startPoint: string, suggestedName = ''): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: `Новая ветка от ${shorten(startPoint)}`,
      value: suggestedName,
      prompt: 'Имя ветки',
      validateInput: (value) => validateRefName(repository, 'branch', value),
    });
    if (!name) return;
    const checkout = 'Создать и переключиться';
    const only = 'Только создать';
    const choice = await vscode.window.showQuickPick([checkout, only], { title: `Ветка ${name}` });
    if (!choice) return;
    const args = choice === checkout ? ['checkout', '-b', name, startPoint] : ['branch', name, startPoint];
    await this.run(repository, `Ветка ${name}`, args);
  }

  async createTag(repository: Repository, revision: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: `Новый тег на ${shorten(revision)}`,
      prompt: 'Имя тега',
      validateInput: (value) => validateRefName(repository, 'tag', value),
    });
    if (name) await this.run(repository, `Тег ${name}`, ['tag', name, revision]);
  }

  async deleteBranch(repository: Repository, snapshot: RepositorySnapshot, ref: Ref): Promise<void> {
    if (ref.kind !== 'head') return;
    if (snapshot.head.branch === ref.name) {
      void vscode.window.showWarningMessage(`Нельзя удалить текущую ветку ${ref.name}.`);
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Удалить локальную ветку ${ref.name}?`,
      { modal: true },
      'Удалить',
    );
    if (!ok) return;
    try {
      await repository.git.run(['branch', '-d', ref.name]);
      this.repositories.notifyChanged(repository);
    } catch (error) {
      if (!(error instanceof GitError) || !error.stderr.includes('not fully merged'))
        return this.report(error);
      const force = await vscode.window.showWarningMessage(
        `Ветка ${ref.name} не влита ни в одну ветку. Всё равно удалить?`,
        { modal: true, detail: 'Коммиты останутся доступны только через reflog.' },
        'Удалить',
      );
      if (force) await this.run(repository, `Удаление ${ref.name}`, ['branch', '-D', ref.name]);
    }
  }

  async deleteRemoteBranch(repository: Repository, ref: Ref): Promise<void> {
    if (ref.kind !== 'remote') return;
    const slash = ref.name.indexOf('/');
    const remote = ref.name.slice(0, slash);
    const branch = ref.name.slice(slash + 1);
    const ok = await vscode.window.showWarningMessage(
      `Удалить ветку ${branch} в ${remote}?`,
      {
        modal: true,
        detail: `Выполнится git push ${remote} --delete ${branch}. Ветка пропадёт на сервере для всех; локальная ветка ${branch}, если есть, останется.`,
      },
      'Удалить в ' + remote,
    );
    if (ok) await this.run(repository, `Удаление ${ref.name}`, ['push', remote, '--delete', branch], true);
  }

  async revert(repository: Repository, hash: string, parents: string[]): Promise<void> {
    const args = ['revert', '--no-edit'];
    if (parents.length > 1) {
      const picked = await vscode.window.showQuickPick(
        parents.map((p, i) => ({ label: `Родитель ${i + 1}`, description: shorten(p), number: i + 1 })),
        { title: 'Merge-коммит: относительно какого родителя отменять?' },
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
          { location: vscode.ProgressLocation.Notification, title: `Grove: ${title}` },
          task,
        );
      } else {
        await task();
      }
      vscode.window.setStatusBarMessage(`Grove: ${title} — готово`, 3000);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Git: ${message}`);
  }
}

function shorten(revision: string): string {
  return /^[0-9a-f]{40,64}$/.test(revision) ? revision.slice(0, 8) : revision;
}

async function validateRefName(
  repository: Repository,
  kind: 'branch' | 'tag',
  value: string,
): Promise<string | undefined> {
  if (!value.trim()) return 'Имя не может быть пустым';
  const prefix = kind === 'branch' ? 'refs/heads/' : 'refs/tags/';
  try {
    await repository.git.run(['check-ref-format', `${prefix}${value}`]);
  } catch {
    return 'Недопустимое имя для git';
  }
  const exists = await repository.revParse(`${prefix}${value}`);
  return exists ? 'Такое имя уже есть' : undefined;
}
