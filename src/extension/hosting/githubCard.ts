import type {
  DiscussionsView,
  MergeRequestCardView,
  PipelineJobView,
  PipelineStageView,
  PipelineStatusView,
} from '../../shared/protocol';

type Login = { login: string } | null;

export interface RawCheckRun {
  __typename: 'CheckRun';
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  checkSuite: { workflowRun: { databaseId: number; workflow: { name: string } } | null } | null;
}

export interface RawStatusContext {
  __typename: 'StatusContext';
  context: string;
  state: string;
  targetUrl: string | null;
}

export interface RawPullRequestCard {
  id: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  url: string;
  author: Login;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  comments: { totalCount: number; nodes: { author: Login; body: string; createdAt: string }[] };
  reviewRequests: { nodes: { requestedReviewer: { login?: string; name?: string } | null }[] };
  latestReviews: { nodes: { author: Login; state: string }[] };
  reviewThreads: {
    totalCount: number;
    nodes: {
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      originalLine: number | null;
      comments: { totalCount: number; nodes: { author: Login; body: string }[] };
    }[];
  };
  commits: {
    nodes: {
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: { nodes: (RawCheckRun | RawStatusContext | Record<string, never>)[] };
        } | null;
      };
    }[];
  };
}

const ROLLUP: Record<string, PipelineStatusView> = {
  SUCCESS: 'success',
  FAILURE: 'failed',
  ERROR: 'failed',
  PENDING: 'running',
  EXPECTED: 'pending',
};

const CONCLUSIONS: Record<string, PipelineStatusView> = {
  SUCCESS: 'success',
  FAILURE: 'failed',
  TIMED_OUT: 'failed',
  STARTUP_FAILURE: 'failed',
  CANCELLED: 'canceled',
  SKIPPED: 'skipped',
  NEUTRAL: 'skipped',
  STALE: 'skipped',
  ACTION_REQUIRED: 'manual',
};

function checkStatus(run: RawCheckRun): PipelineStatusView {
  if (run.status === 'COMPLETED') return CONCLUSIONS[run.conclusion ?? ''] ?? 'success';
  if (run.status === 'IN_PROGRESS') return 'running';
  return 'pending';
}

const name = (login: Login) => login?.login ?? 'ghost';

/** Checks grouped as stages by their workflow; commit statuses of other services go to their own group. */
function checkStages(
  card: RawPullRequestCard,
): { status: PipelineStatusView; stages: PipelineStageView[] } | undefined {
  const rollup = card.commits.nodes[0]?.commit.statusCheckRollup;
  if (!rollup) return undefined;
  const stages = new Map<string, PipelineJobView[]>();
  const add = (stage: string, job: PipelineJobView) => stages.set(stage, [...(stages.get(stage) ?? []), job]);
  for (const node of rollup.contexts.nodes) {
    if (node.__typename === 'CheckRun') {
      const run = node as RawCheckRun;
      const workflow = run.checkSuite?.workflowRun;
      const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
      const completed = run.completedAt ? Date.parse(run.completedAt) : NaN;
      add(workflow?.workflow.name ?? 'Checks', {
        id: run.databaseId,
        name: run.name,
        status: checkStatus(run),
        duration: completed > started ? (completed - started) / 1000 : undefined,
        allowFailure: false,
        // Only jobs of GitHub Actions have logs Kleio can open; others are shown by their service.
        webUrl: workflow ? undefined : (run.detailsUrl ?? undefined),
        runId: workflow?.databaseId,
      });
    } else if (node.__typename === 'StatusContext') {
      const status = node as RawStatusContext;
      add('Statuses', {
        id: 0,
        name: status.context,
        status: ROLLUP[status.state] ?? 'pending',
        allowFailure: false,
        webUrl: status.targetUrl ?? undefined,
      });
    }
  }
  return {
    status: ROLLUP[rollup.state] ?? 'pending',
    stages: [...stages].map(([stage, jobs]) => ({ name: stage, jobs })),
  };
}

function discussions(card: RawPullRequestCard): DiscussionsView {
  const threads = card.reviewThreads.nodes.map((thread) => {
    const first = thread.comments.nodes[0];
    return {
      path: thread.path,
      line: thread.line ?? thread.originalLine ?? 0,
      author: name(first?.author ?? null),
      body: first?.body ?? '',
      replies: Math.max(0, thread.comments.totalCount - 1),
      resolvable: true,
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
    };
  });
  return {
    unresolved: threads.filter((th) => !th.resolved).length,
    drafts: 0,
    general: card.comments.nodes.map((c) => ({
      author: name(c.author),
      body: c.body,
      createdAt: c.createdAt,
    })),
    threads,
  };
}

/** The card of a GitHub pull request in the shape the log shows merge requests in. */
export function buildGitHubCard(card: RawPullRequestCard, viewer: string): MergeRequestCardView {
  const reviews = new Map(card.latestReviews.nodes.map((r) => [name(r.author), r.state]));
  const requested = card.reviewRequests.nodes
    .map((r) => r.requestedReviewer?.login ?? r.requestedReviewer?.name)
    .filter((n): n is string => !!n);
  const reviewers = [...new Set([...requested, ...reviews.keys()])].map((reviewer) => ({
    name: reviewer,
    approved: reviews.get(reviewer) === 'APPROVED',
  }));
  const checks = checkStages(card);
  return {
    kind: 'github',
    iid: card.number,
    title: card.title,
    state: card.state === 'OPEN' ? 'opened' : card.state === 'MERGED' ? 'merged' : 'closed',
    draft: card.isDraft,
    webUrl: card.url,
    author: name(card.author),
    sourceBranch: card.headRefName,
    targetBranch: card.baseRefName,
    hasConflicts: card.mergeable === 'CONFLICTING',
    mergeStatus: card.mergeStateStatus.toLowerCase(),
    notes: card.comments.totalCount + card.reviewThreads.totalCount,
    reviewers,
    approvedBy: [],
    approvalsLeft: card.reviewDecision === 'REVIEW_REQUIRED' ? 1 : 0,
    pipeline: checks && {
      id: 0,
      status: checks.status,
      webUrl: `${card.url}/checks`,
      stages: checks.stages,
    },
    discussions: discussions(card),
    approvedByMe: reviews.get(viewer) === 'APPROVED',
  };
}
