import * as vscode from 'vscode';
import { t } from '../../shared/l10n';
import type { Ref } from '../../shared/model';
import type { GitActions } from '../actions/gitActions';
import type { Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';

const COMMAND = 'kleio.git.branches';

/**
 * Rider's branch widget: the current branch with its ↑↓ against the upstream, or the operation in progress,
 * in the status bar; a click opens the branches with the common actions.
 */
export class BranchStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'kleio.branch',
    vscode.StatusBarAlignment.Left,
    9,
  );
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly repositories: RepositoryManager,
    private readonly actions: GitActions,
  ) {
    this.item.name = t('Kleio: current branch');
    this.item.command = COMMAND;
    this.disposables.push(
      this.item,
      vscode.commands.registerCommand(COMMAND, () => this.pick()),
      repositories.onDidChangeRepository((repository) => {
        if (repository === this.current()) void this.update();
      }),
      repositories.onDidChangeRepositories(() => void this.update()),
      repositories.onDidChangeCurrent(() => void this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('kleio.statusBar.branch')) void this.update();
      }),
    );
    void this.update();
  }

  /** The repository of the active editor, or the first one. */
  private current(): Repository | undefined {
    return this.repositories.current;
  }

  private async update(): Promise<void> {
    const repository = this.current();
    const enabled = vscode.workspace.getConfiguration('kleio').get<boolean>('statusBar.branch', true);
    if (!repository || !enabled) {
      this.item.hide();
      return;
    }
    try {
      const [head, refs, operation] = await Promise.all([
        repository.head(),
        repository.refs(),
        repository.operation(),
      ]);
      const branch = refs.find((r) => r.kind === 'head' && r.name === head.branch);
      const name = head.branch ?? head.hash?.slice(0, 8) ?? 'HEAD';
      const prefix = this.repositories.all.length > 1 ? `${repository.name} / ` : '';
      const sync = [branch?.ahead ? `↑${branch.ahead}` : '', branch?.behind ? `↓${branch.behind}` : '']
        .filter(Boolean)
        .join(' ');
      if (operation) {
        const step = operation.step && operation.total ? ` ${operation.step}/${operation.total}` : '';
        this.item.text = `$(git-branch) ${prefix}${name} · ${operation.kind}${step}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        this.item.text = `$(git-branch) ${prefix}${name}${sync ? ` ${sync}` : ''}`;
        this.item.backgroundColor = undefined;
      }
      this.item.tooltip = [
        repository.name,
        branch?.upstream
          ? t('Tracks {0}', branch.upstream.replace('refs/remotes/', ''))
          : head.branch
            ? t('No upstream')
            : t('No branch (detached HEAD)'),
        t('Click for branches and actions'),
      ].join('\n');
      this.item.show();
    } catch {
      this.item.hide();
    }
  }

  private async pick(): Promise<void> {
    const repository = this.current();
    if (!repository) return;
    const snapshot = await repository.snapshot({ limit: 1 });
    const current = snapshot.head.branch;
    type Item = vscode.QuickPickItem & { run?: () => Thenable<unknown> | Promise<unknown> };
    const command = (label: string, id: string): Item => ({
      label,
      run: () => vscode.commands.executeCommand(id),
    });
    const branch = (ref: Ref): Item => ({
      label: `$(${ref.kind === 'head' ? 'git-branch' : 'cloud'}) ${ref.name}`,
      description: [
        ref.ahead ? `↑${ref.ahead}` : '',
        ref.behind ? `↓${ref.behind}` : '',
        ref.upstreamGone ? t('gone on the remote') : '',
      ]
        .filter(Boolean)
        .join(' '),
      run: () => this.actions.checkoutRef(repository, snapshot, ref),
    });
    const local = snapshot.refs.filter((r) => r.kind === 'head' && r.name !== current);
    const remote = snapshot.refs.filter((r) => r.kind === 'remote' && !r.name.endsWith('/HEAD'));
    const others = this.repositories.all.filter((r) => r !== repository);
    const items: Item[] = [
      ...(others.length
        ? [
            { label: t('Repositories'), kind: vscode.QuickPickItemKind.Separator },
            ...others.map((other): Item => ({
              label: `$(repo) ${other.name}`,
              description: t('switch to this repository'),
              run: async () => {
                this.repositories.setCurrent(other);
                await this.pick();
              },
            })),
            { label: repository.name, kind: vscode.QuickPickItemKind.Separator },
          ]
        : []),
      command(`$(repo-pull) ${t('Update Project')}`, 'kleio.git.updateProject'),
      command(`$(repo-push) ${t('Push…')}`, 'kleio.git.push'),
      command(`$(git-commit) ${t('Show Log')}`, 'kleio.log.focusView'),
      {
        label: `$(add) ${t('New Branch…')}`,
        run: () => this.actions.createBranch(repository, current ?? snapshot.head.hash ?? 'HEAD'),
      },
      command(`$(discard) ${t('Undo via Reflog…')}`, 'kleio.git.undo'),
      { label: t('Local branches'), kind: vscode.QuickPickItemKind.Separator },
      ...local.map(branch),
      { label: t('Remote branches'), kind: vscode.QuickPickItemKind.Separator },
      ...remote.map(branch),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: current ? t('Branch {0}', current) : t('No branch (detached HEAD)'),
      placeHolder: t('Check out a branch or run an action'),
      matchOnDescription: true,
    });
    await picked?.run?.();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
