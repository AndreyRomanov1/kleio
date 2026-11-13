import * as vscode from 'vscode';
import type { Repository } from '../git/repository';
import { t } from '../../shared/l10n';

export type PullStrategy = 'rebase' | 'merge' | 'ff-only';

/** The effective rule of git pull for diverged histories and where Git took it from. */
export interface PullRule {
  strategy: PullStrategy;
  key: string;
  scope: string;
}

/**
 * What git pull does when the histories have diverged, by `branch.<name>.rebase`, `pull.rebase` and `pull.ff`;
 * undefined when none is set and Git refuses to pull until told how to reconcile.
 */
export function pullStrategy(values: {
  branchRebase?: string;
  pullRebase?: string;
  pullFf?: string;
}): PullStrategy | undefined {
  const rebase = values.branchRebase || values.pullRebase;
  if (rebase && !['false', 'no', 'off', '0'].includes(rebase)) return 'rebase';
  if (values.pullFf === 'only') return 'ff-only';
  if (rebase || values.pullFf) return 'merge';
  return undefined;
}

export class PullSettings {
  constructor(private readonly repository: Repository) {}

  private async get(key: string): Promise<{ value: string; scope: string } | undefined> {
    const output = await this.repository.git.run(['config', '--show-scope', '--get', key], {
      allowExitCodes: [1],
    });
    const [scope, ...value] = output.trim().split('\t');
    return value.length ? { value: value.join('\t'), scope } : undefined;
  }

  async rule(branch: string): Promise<PullRule | undefined> {
    const [branchRebase, pullRebase, pullFf] = await Promise.all([
      this.get(`branch.${branch}.rebase`),
      this.get('pull.rebase'),
      this.get('pull.ff'),
    ]);
    const strategy = pullStrategy({
      branchRebase: branchRebase?.value,
      pullRebase: pullRebase?.value,
      pullFf: pullFf?.value,
    });
    if (!strategy) return undefined;
    const [key, source] =
      strategy === 'ff-only'
        ? ['pull.ff', pullFf]
        : branchRebase
          ? [`branch.${branch}.rebase`, branchRebase]
          : pullRebase
            ? ['pull.rebase', pullRebase]
            : ['pull.ff', pullFf];
    return { strategy, key, scope: source?.scope ?? '' };
  }

  /**
   * Asks how to reconcile diverged histories — Git refuses to pull without the rule — and saves the answer
   * in the repository config, where `git pull` in a terminal finds it too.
   */
  async askWhenDiverged(branch: string, upstream: string, ahead: number, behind: number): Promise<boolean> {
    const rebase = 'Rebase';
    const merge = 'Merge';
    const choice = await vscode.window.showInformationMessage(
      t('{0} and {1} have diverged', branch, upstream),
      {
        modal: true,
        detail: [
          t('You have {0} commit(s), the server has {1} new.', ahead, behind),
          '',
          'Rebase — ' + t('Your commits go on top of the new ones; their hashes change'),
          'Merge — ' + t('A merge commit joins the histories'),
          '',
          t('The choice is saved for this repository (git config pull.rebase).'),
        ].join('\n'),
      },
      rebase,
      merge,
    );
    if (!choice) return false;
    const strategy = choice === rebase ? 'rebase' : 'merge';
    const key = await this.save(branch, strategy, '--local');
    vscode.window.setStatusBarMessage(
      t('Kleio: saved for the repository: {0}={1}', key, strategy === 'rebase' ? 'true' : 'false'),
      6000,
    );
    return true;
  }

  /** The Pull Strategy command: shows the effective rule and where it comes from, and changes it. */
  async choose(branch: string): Promise<void> {
    const current = await this.rule(branch);
    const names: Record<PullStrategy, string> = {
      rebase: 'Rebase',
      merge: 'Merge',
      'ff-only': t('Fast-forward only'),
    };
    const items: (vscode.QuickPickItem & { strategy: PullStrategy })[] = [
      {
        label: 'Rebase',
        strategy: 'rebase',
        detail: t('Your commits go on top of the new ones; their hashes change'),
      },
      { label: 'Merge', strategy: 'merge', detail: t('A merge commit joins the histories') },
      {
        label: t('Fast-forward only'),
        strategy: 'ff-only',
        detail: t('Pull refuses when the histories have diverged'),
      },
    ];
    for (const item of items) if (item.strategy === current?.strategy) item.description = t('current');
    const picked = await vscode.window.showQuickPick(items, {
      title: current
        ? t('Pull strategy: {0} ({1}, {2} config)', names[current.strategy], current.key, current.scope)
        : t('Pull strategy: not set, asked when the histories diverge'),
    });
    if (!picked) return;
    // A rule of this branch is kept in the repository and overrides the rest, so the choice replaces it there.
    const scope = current?.key.startsWith('branch.')
      ? { flag: '--local' }
      : await vscode.window.showQuickPick(
          [
            { label: t('This repository'), detail: '.git/config', flag: '--local' },
            {
              label: t('All repositories'),
              detail: t(
                '~/.gitconfig; git in the terminal follows it too, a repository rule takes precedence',
              ),
              flag: '--global',
            },
          ],
          { title: t('Where to save the Pull strategy?') },
        );
    if (!scope) return;
    await this.save(branch, picked.strategy, scope.flag);
    const saved = await this.rule(branch);
    if (saved?.strategy !== picked.strategy)
      void vscode.window.showWarningMessage(
        t('Saved, but {0} from the {1} config still takes precedence.', saved?.key ?? '', saved?.scope ?? ''),
      );
  }

  /** Writes the strategy with `git config <flag>` and returns the key that holds it. */
  private async save(branch: string, strategy: PullStrategy, flag: string): Promise<string> {
    const git = this.repository.git;
    const branchKey = `branch.${branch}.rebase`;
    const rebaseKey =
      flag === '--local' && (await this.get(branchKey))?.scope === 'local' ? branchKey : 'pull.rebase';
    const unset = (key: string) => git.run(['config', flag, '--unset', key], { allowExitCodes: [5] });
    if (strategy === 'ff-only') {
      await unset(rebaseKey);
      await git.run(['config', flag, 'pull.ff', 'only']);
      return 'pull.ff';
    }
    await git.run(['config', flag, rebaseKey, strategy === 'rebase' ? 'true' : 'false']);
    const ff = await git.run(['config', flag, '--get', 'pull.ff'], { allowExitCodes: [1] });
    if (ff.trim() === 'only') await unset('pull.ff');
    return rebaseKey;
  }
}
