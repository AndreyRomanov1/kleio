import * as vscode from 'vscode';
import { t } from '../../../shared/l10n';
import type { ChangeSetNavigator } from '../../changes/changeSetNavigator';
import type { Repository } from '../../git/repository';
import type { HostingService } from '../../hosting/hostingService';

/**
 * The changes of a GitHub pull request in the diff viewer, as GitHub shows them: from where the branch left
 * its target. Comments in the code stay on GitHub for now.
 */
export async function openPullRequest(
  hosting: HostingService,
  navigator: ChangeSetNavigator,
  repository: Repository,
  number: number,
  filePath?: string,
  line?: number,
): Promise<void> {
  const github = await hosting.github(repository, true);
  if (!github) {
    void vscode.window.showWarningMessage(t('The review needs access to GitHub.'));
    return;
  }
  const opened = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Kleio: pull request #{0}', number) },
    async () => {
      const { card } = await github.pullRequestCard(number);
      const remote = (await hosting.known(repository))?.remoteName ?? 'origin';
      const has = async () =>
        !!(await repository.revParse(card.headRefOid)) && !!(await repository.revParse(card.baseRefOid));
      if (!(await has()))
        await repository.git
          .run(['fetch', remote, `refs/pull/${number}/head`, card.baseRefName], { timeoutMs: 120_000 })
          .catch(() => undefined);
      if (!(await has())) return undefined;
      const base = (await repository.git.run(['merge-base', card.baseRefOid, card.headRefOid])).trim();
      return { base, head: card.headRefOid, files: await repository.changes(base, card.headRefOid) };
    },
  );
  if (!opened) {
    void vscode.window.showErrorMessage(t('Could not fetch the commits of #{0}.', number));
    return;
  }
  if (!opened.files.length) {
    void vscode.window.showInformationMessage(t('Pull request #{0} has no changes.', number));
    return;
  }
  const index = filePath ? opened.files.findIndex((f) => f.path === filePath || f.oldPath === filePath) : 0;
  await navigator.open(
    { repository, title: `PR #${number}`, left: opened.base, right: opened.head, files: opened.files },
    Math.max(0, index),
    'first',
    { line: line === undefined ? undefined : line - 1 },
  );
}
