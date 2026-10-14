import type { MergeRequestCardView, PipelineJobView, PipelineStageView } from '../../shared/protocol';
import type { Approvals, Bridge, Job, MergeRequestDetails } from './gitlabApi';

/** Jobs of child pipelines, by child pipeline id. */
export type ChildJobs = Record<number, Job[]>;

/**
 * The card of a merge request: reviewers with their approvals and the pipeline grouped by stages. Trigger jobs
 * (bridges) take their place in their stage and carry the stages of the child pipeline they started.
 */
export function buildCard(
  details: MergeRequestDetails,
  approvals: Approvals,
  jobs: Job[],
  bridges: Bridge[] = [],
  children: ChildJobs = {},
): MergeRequestCardView {
  const approved = new Set(approvals.approvedBy.map((p) => p.username));
  const items: PipelineJobView[] = [
    ...jobs.map((job) => jobView(job)),
    ...bridges.map((bridge): PipelineJobView => ({
      ...jobView(bridge),
      bridge: true,
      child: bridge.downstream
        ? {
            id: bridge.downstream.id,
            status: bridge.downstream.status,
            webUrl: bridge.downstream.webUrl,
            stages: groupStages(
              (children[bridge.downstream.id] ?? []).map((job) => jobView(job, bridge.downstream!.projectId)),
              (children[bridge.downstream.id] ?? []).map((job) => job.stage),
            ),
          }
        : undefined,
    })),
  ];
  const stageOf = new Map<number, string>([...jobs, ...bridges].map((j) => [j.id, j.stage]));
  const ordered = [...items].sort((a, b) => a.id - b.id);
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
    pipeline: details.pipeline
      ? {
          ...details.pipeline,
          stages: groupStages(
            ordered,
            ordered.map((j) => stageOf.get(j.id) ?? ''),
          ),
        }
      : undefined,
  };
}

function jobView(job: Job, projectId?: number): PipelineJobView {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    duration: job.duration,
    allowFailure: job.allowFailure,
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

/** Stages in the order their first job appears. */
function groupStages(jobs: PipelineJobView[], stageNames: string[]): PipelineStageView[] {
  const stages: PipelineStageView[] = [];
  jobs.forEach((job, i) => {
    let stage = stages.find((s) => s.name === stageNames[i]);
    if (!stage) stages.push((stage = { name: stageNames[i], jobs: [] }));
    stage.jobs.push(job);
  });
  return stages;
}
