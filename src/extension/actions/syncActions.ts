import * as vscode from 'vscode';
import type { OperationKind, Ref, RepositorySnapshot } from '../../shared/model';
import type { OperationOutcome, Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';

const FETCH_TIMEOUT_MS = 120_000;

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
    await this.operation(repository, `Rebase ${current} на ${shorten(onto)}`, 'rebase', () =>
      repository.rebase(onto, branch),
    );
  }

  async cherryPick(repository: Repository, hash: string): Promise<void> {
    await this.operation(repository, `Cherry-pick ${shorten(hash)}`, 'cherry-pick', () =>
      repository.cherryPick(hash),
    );
  }

  async continueOperation(repository: Repository, kind: OperationKind): Promise<void> {
    await this.operation(repository, `${operationNames[kind]}: продолжение`, kind, () =>
      repository.continueOperation(kind),
    );
  }

  async skip(repository: Repository, kind: OperationKind): Promise<void> {
    await this.operation(repository, `${operationNames[kind]}: пропуск коммита`, kind, () =>
      repository.skipOperation(kind),
    );
  }

  async abort(repository: Repository, kind: OperationKind): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      `Прервать ${operationNames[kind].toLowerCase()}?`,
      {
        modal: true,
        detail:
          'Ветка вернётся в состояние до начала операции; разрешённые конфликты пропадут. Незакоммиченные изменения, спрятанные на время операции, вернутся.',
      },
      'Прервать',
    );
    if (!ok) return;
    try {
      await repository.abortOperation(kind);
      vscode.window.setStatusBarMessage(`Grove: ${operationNames[kind]} прерван`, 4000);
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
    const fetched = await this.withProgress('Grove: обновление проекта', async (progress) => {
      progress.report({ message: 'fetch' });
      await repository.git.run(['fetch', '--all', '--prune'], { timeoutMs: FETCH_TIMEOUT_MS });
      return true;
    });
    this.repositories.notifyChanged(repository);
    if (!fetched) return;

    const head = await repository.head();
    if (!head.branch) {
      void vscode.window.showInformationMessage('Fetch выполнен. HEAD без ветки — обновлять нечего.');
      return;
    }
    const upstream = await this.upstream(repository, head.branch);
    if (!upstream) {
      void vscode.window.showInformationMessage(
        `Fetch выполнен. У ветки ${head.branch} нет upstream в origin — подтягивать неоткуда.`,
      );
      return;
    }
    const { ahead, behind } = await repository.aheadBehind(head.branch, upstream);
    if (behind === 0) {
      vscode.window.setStatusBarMessage(`Grove: ${head.branch} актуальна`, 4000);
      return;
    }
    const method = vscode.workspace
      .getConfiguration('grove')
      .get<'rebase' | 'merge'>('update.method', 'rebase');
    const title = `Обновление ${head.branch} из ${upstream}: ${behind} новых`;
    if (ahead === 0) {
      await this.operation(repository, title, 'merge', () =>
        repository.merge(upstream, { fastForwardOnly: true }),
      );
    } else if (method === 'merge') {
      await this.operation(repository, title, 'merge', () => repository.merge(upstream));
    } else {
      await this.operation(repository, title, 'rebase', () => repository.rebase(upstream));
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
      void vscode.window.showInformationMessage(`У ветки ${ref.name} нет upstream — обновлять неоткуда.`);
      return;
    }
    const worktree = snapshot.worktrees.find((w) => w.branch === ref.name);
    if (worktree) {
      void vscode.window.showInformationMessage(
        `Ветка ${ref.name} открыта в worktree ${worktree.path} — обновите её там.`,
      );
      return;
    }
    const slash = upstreamRef.name.indexOf('/');
    const remote = upstreamRef.name.slice(0, slash);
    const remoteBranch = upstreamRef.name.slice(slash + 1);
    const fetched = await this.withProgress(`Grove: fetch ${upstreamRef.name}`, async () => {
      await repository.git.run(['fetch', remote, remoteBranch], { timeoutMs: FETCH_TIMEOUT_MS });
      return true;
    });
    if (!fetched) return;
    const [local, upstream] = await Promise.all([
      repository.revParse(ref.fullName),
      repository.revParse(upstreamRef.fullName),
    ]);
    if (!local || !upstream) return;
    const { ahead, behind } = await repository.aheadBehind(local, upstream);
    if (behind === 0) {
      vscode.window.setStatusBarMessage(`Grove: ${ref.name} актуальна`, 4000);
    } else if (ahead > 0) {
      void vscode.window.showWarningMessage(
        `Ветка ${ref.name} разошлась с ${upstreamRef.name}: ${ahead} своих коммитов, ${behind} новых. Без переключения её можно обновить, только если своих коммитов нет — переключитесь на неё и обновите проект.`,
      );
    } else {
      try {
        await repository.moveBranch(ref.name, upstream, local);
        vscode.window.setStatusBarMessage(`Grove: ${ref.name} +${behind} из ${upstreamRef.name}`, 4000);
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
          detail: 'Изменения коммитов после этого останутся в индексе',
        },
        {
          label: 'Mixed',
          mode: 'mixed' as const,
          detail: 'Изменения останутся в рабочей копии, индекс очистится',
        },
        {
          label: 'Hard',
          mode: 'hard' as const,
          detail: 'Изменения коммитов и незакоммиченные правки пропадут',
        },
      ],
      { title: `Reset ${branch} на ${shorten(hash)}` },
    );
    if (!picked) return;
    if (picked.mode === 'hard') {
      const ok = await vscode.window.showWarningMessage(
        `Hard reset ${branch} на ${shorten(hash)}?`,
        {
          modal: true,
          detail:
            'Незакоммиченные изменения отслеживаемых файлов пропадут безвозвратно; коммиты останутся в reflog.',
        },
        'Hard reset',
      );
      if (!ok) return;
    }
    try {
      await repository.reset(hash, picked.mode);
      vscode.window.setStatusBarMessage(`Grove: reset ${branch} на ${shorten(hash)}`, 4000);
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
    const outcome = await this.withProgress(`Grove: ${title}`, run);
    this.repositories.notifyChanged(repository);
    if (outcome === undefined) return;
    if (outcome === 'done') {
      vscode.window.setStatusBarMessage(`Grove: ${title} — готово`, 4000);
      return;
    }
    const state = await repository.operation();
    const name = operationNames[state?.kind ?? kind];
    if (outcome === 'stopped') {
      void vscode.window.showInformationMessage(
        `${name} остановлен${state?.stoppedAt ? ` на ${shorten(state.stoppedAt)}` : ''}: внесите правки и нажмите «Продолжить» в логе.`,
      );
      return;
    }
    const files = state?.conflicted ?? [];
    const resolve = 'Разрешить конфликты';
    const abort = 'Прервать';
    const choice = await vscode.window.showWarningMessage(
      `${name}: конфликты в ${files.length} файл(ах)`,
      { detail: files.slice(0, 10).join('\n') },
      ...(this.showConflicts ? [resolve] : []),
      abort,
    );
    if (choice === resolve) await this.showConflicts?.(repository);
    else if (choice === abort && state) await this.abort(repository, state.kind);
  }

  private async upstream(repository: Repository, branch: string): Promise<string | undefined> {
    const output = await repository.git.run(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`],
      { allowExitCodes: [128] },
    );
    return output.trim() || undefined;
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
    void vscode.window.showWarningMessage('HEAD без ветки: сначала переключитесь на ветку.');
  }
}

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`Git: ${message}`);
}

function shorten(revision: string): string {
  return /^[0-9a-f]{40,64}$/.test(revision) ? revision.slice(0, 8) : revision;
}
