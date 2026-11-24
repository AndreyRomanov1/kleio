import * as vscode from 'vscode';
import { t } from '../../shared/l10n';
import type { Ref } from '../../shared/model';
import type { Repository } from '../git/repository';
import type { HostingService } from '../hosting/hostingService';
import type { ReviewController } from './reviewController';

type Choice = vscode.QuickPickItem & { run: () => Promise<void> };

/**
 * One entry to every review: the merge request of the current branch in GitLab (or GitHub), or a branch with
 * threads kept on this machine.
 */
export async function startReview(
  repository: Repository,
  hosting: HostingService,
  review: ReviewController,
): Promise<void> {
  const [head, refs, info] = await Promise.all([
    repository.head(),
    repository.refs(),
    hosting.hosting(repository, false).catch(() => undefined),
  ]);
  const branch = head.branch ? refs.find((r) => r.kind === 'head' && r.name === head.branch) : undefined;
  const choices: Choice[] = [];

  // The merge request is at the upstream: local commits move the branch itself ahead of it.
  const upstream = branch?.upstream ? refs.find((r) => r.fullName === branch.upstream) : undefined;
  const iid = [upstream?.hash, branch?.hash]
    .flatMap((hash) => (hash ? (info?.mergeRequests[hash] ?? []) : []))
    .find((n) => info?.mergeRequestInfo[n]?.state === 'opened');
  if (iid !== undefined)
    choices.push({
      label: `$(git-pull-request) !${iid} ${info?.mergeRequestInfo[iid]?.title ?? ''}`,
      description: info?.links?.name,
      run: () => review.start(repository, iid),
    });

  if (branch)
    choices.push({
      label: `$(git-branch) ${t('Branch {0} locally', branch.name)}`,
      description: t('comments are kept on this computer'),
      run: () => reviewBranch(repository, hosting, review, branch),
    });
  choices.push({
    label: `$(list-tree) ${t('Another branch locally…')}`,
    run: async () => {
      const other = await pickBranch(refs.filter((r) => r.kind !== 'tag' && r !== branch));
      if (other) await reviewBranch(repository, hosting, review, other);
    },
  });

  const choice = await vscode.window.showQuickPick(choices, { placeHolder: t('What to review') });
  await choice?.run();
}

async function reviewBranch(
  repository: Repository,
  hosting: HostingService,
  review: ReviewController,
  ref: Ref,
): Promise<void> {
  const target = await hosting.branchTarget(repository, ref);
  if (!target) {
    void vscode.window.showWarningMessage(t('Kleio: the branch to compare {0} with is unknown.', ref.name));
    return;
  }
  await review.startLocal(repository, { kind: 'branch', branch: ref.name, target });
}

async function pickBranch(refs: Ref[]): Promise<Ref | undefined> {
  const picked = await vscode.window.showQuickPick(
    refs.map((ref) => ({
      label: `$(${ref.kind === 'remote' ? 'cloud' : 'git-branch'}) ${ref.name}`,
      ref,
    })),
    { placeHolder: t('Branch to review') },
  );
  return picked?.ref;
}
