import type { MergeRequestCardView } from '../../shared/protocol';
import type { Approvals, Job, MergeRequestDetails } from './gitlabApi';

/** The card of a merge request: reviewers with their approvals and the pipeline grouped by stages. */
export function buildCard(
  details: MergeRequestDetails,
  approvals: Approvals,
  jobs: Job[],
): MergeRequestCardView {
  const approved = new Set(approvals.approvedBy.map((p) => p.username));
  const stages: NonNullable<MergeRequestCardView['pipeline']>['stages'] = [];
  for (const job of jobs) {
    let stage = stages.find((s) => s.name === job.stage);
    if (!stage) stages.push((stage = { name: job.stage, jobs: [] }));
    stage.jobs.push({
      id: job.id,
      name: job.name,
      status: job.status,
      duration: job.duration,
      allowFailure: job.allowFailure,
    });
  }
  return {
    iid: details.iid,
    title: details.title,
    state: details.state,
    draft: details.draft,
    webUrl: details.webUrl,
    author: details.author.name,
    sourceBranch: details.sourceBranch,
    targetBranch: details.targetBranch,
    hasConflicts: details.hasConflicts,
    mergeStatus: details.mergeStatus,
    notes: details.userNotesCount,
    reviewers: details.reviewers.map((r) => ({ name: r.name, approved: approved.has(r.username) })),
    approvedBy: approvals.approvedBy
      .filter((p) => !details.reviewers.some((r) => r.username === p.username))
      .map((p) => p.name),
    approvalsLeft: approvals.left,
    pipeline: details.pipeline ? { ...details.pipeline, stages } : undefined,
  };
}
