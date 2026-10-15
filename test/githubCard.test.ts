import { describe, expect, it } from 'vitest';
import { buildGitHubCard, type RawPullRequestCard } from '../src/extension/hosting/githubCard';

const raw: RawPullRequestCard = {
  id: 'PR_1',
  number: 7,
  title: 'Feature',
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/o/r/pull/7',
  author: { login: 'ann' },
  headRefName: 'feature',
  baseRefName: 'main',
  headRefOid: 'h',
  baseRefOid: 'b',
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  reviewDecision: 'REVIEW_REQUIRED',
  comments: { totalCount: 1, nodes: [{ author: null, body: 'hi', createdAt: '2026-10-01T10:00:00Z' }] },
  reviewRequests: {
    nodes: [{ requestedReviewer: { login: 'bob' } }, { requestedReviewer: { name: 'core' } }],
  },
  latestReviews: { nodes: [{ author: { login: 'me' }, state: 'APPROVED' }] },
  reviewThreads: {
    totalCount: 2,
    nodes: [
      {
        isResolved: false,
        isOutdated: false,
        path: 'a.ts',
        line: 3,
        originalLine: 3,
        comments: { totalCount: 2, nodes: [{ author: { login: 'bob' }, body: 'why?' }] },
      },
      {
        isResolved: true,
        isOutdated: true,
        path: 'b.ts',
        line: null,
        originalLine: 9,
        comments: { totalCount: 1, nodes: [{ author: { login: 'bob' }, body: 'ok' }] },
      },
    ],
  },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: 'FAILURE',
            contexts: {
              nodes: [
                {
                  __typename: 'CheckRun',
                  databaseId: 11,
                  name: 'build',
                  status: 'COMPLETED',
                  conclusion: 'FAILURE',
                  detailsUrl: 'https://github.com/o/r/actions/runs/5/job/11',
                  startedAt: '2026-10-01T10:00:00Z',
                  completedAt: '2026-10-01T10:01:30Z',
                  checkSuite: { workflowRun: { databaseId: 5, workflow: { name: 'CI' } } },
                },
                {
                  __typename: 'CheckRun',
                  databaseId: 12,
                  name: 'lint',
                  status: 'IN_PROGRESS',
                  conclusion: null,
                  detailsUrl: null,
                  startedAt: null,
                  completedAt: null,
                  checkSuite: { workflowRun: { databaseId: 5, workflow: { name: 'CI' } } },
                },
                {
                  __typename: 'CheckRun',
                  databaseId: 13,
                  name: 'codecov',
                  status: 'COMPLETED',
                  conclusion: 'NEUTRAL',
                  detailsUrl: 'https://codecov.io/x',
                  startedAt: null,
                  completedAt: null,
                  checkSuite: { workflowRun: null },
                },
                {
                  __typename: 'StatusContext',
                  context: 'ci/jenkins',
                  state: 'SUCCESS',
                  targetUrl: 'https://j/x',
                },
                {},
              ],
            },
          },
        },
      },
    ],
  },
};

describe('GitHub pull request card', () => {
  it('shows a pull request as a merge request card', () => {
    const card = buildGitHubCard(raw, 'me');
    expect(card).toMatchObject({
      kind: 'github',
      iid: 7,
      state: 'opened',
      author: 'ann',
      sourceBranch: 'feature',
      targetBranch: 'main',
      hasConflicts: true,
      mergeStatus: 'dirty',
      notes: 3,
      approvalsLeft: 1,
      approvedByMe: true,
    });
    expect(card.reviewers).toEqual([
      { name: 'bob', approved: false },
      { name: 'core', approved: false },
      { name: 'me', approved: true },
    ]);
  });

  it('groups checks by workflow; checks of other services link to their page', () => {
    const pipeline = buildGitHubCard(raw, 'me').pipeline!;
    expect(pipeline.status).toBe('failed');
    expect(pipeline.webUrl).toBe('https://github.com/o/r/pull/7/checks');
    expect(pipeline.stages.map((s) => [s.name, s.jobs.map((j) => [j.name, j.status])])).toEqual([
      [
        'CI',
        [
          ['build', 'failed'],
          ['lint', 'running'],
        ],
      ],
      ['Checks', [['codecov', 'skipped']]],
      ['Statuses', [['ci/jenkins', 'success']]],
    ]);
    const [build] = pipeline.stages[0].jobs;
    expect(build).toMatchObject({ id: 11, runId: 5, duration: 90, webUrl: undefined });
    expect(pipeline.stages[1].jobs[0].webUrl).toBe('https://codecov.io/x');
  });

  it('turns review threads and comments into discussions', () => {
    const d = buildGitHubCard(raw, 'me').discussions!;
    expect(d.unresolved).toBe(1);
    expect(d.general).toEqual([{ author: 'ghost', body: 'hi', createdAt: '2026-10-01T10:00:00Z' }]);
    expect(d.threads).toEqual([
      {
        path: 'a.ts',
        line: 3,
        author: 'bob',
        body: 'why?',
        replies: 1,
        resolvable: true,
        resolved: false,
        outdated: false,
      },
      {
        path: 'b.ts',
        line: 9,
        author: 'bob',
        body: 'ok',
        replies: 0,
        resolvable: true,
        resolved: true,
        outdated: true,
      },
    ]);
  });
});
