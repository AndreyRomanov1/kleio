import type { MergedMergeRequest, MergeRequestSummary, PipelineStatus } from './gitlabApi';
import type { RawPullRequestCard } from './githubCard';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

interface RawPullRequest {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  url: string;
  updatedAt?: string;
  headRefOid?: string;
  mergeCommit?: { oid: string } | null;
}

/** Commit check states of GitHub as the pipeline statuses the log shows. */
const ROLLUP: Record<string, PipelineStatus> = {
  SUCCESS: 'success',
  FAILURE: 'failed',
  ERROR: 'failed',
  PENDING: 'running',
  EXPECTED: 'pending',
};

const PR_FIELDS = 'number title state isDraft url';
/** Aliases per GraphQL query: one request answers for a whole screen of the log. */
const BATCH = 100;

/**
 * What the log needs from GitHub, through GraphQL so that a hundred pull requests or commits cost one
 * request: pull request states, the combined status of checks of commits, merged pull requests by pages.
 */
export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';

const CHECK_FIELDS = `
  __typename
  ... on CheckRun {
    databaseId name status conclusion detailsUrl startedAt completedAt
    checkSuite { workflowRun { databaseId workflow { name } } }
  }
  ... on StatusContext { context state targetUrl }`;

const CARD_FIELDS = `
  id number title state isDraft url author { login } headRefName baseRefName headRefOid baseRefOid
  mergeable mergeStateStatus reviewDecision
  comments(last: 50) { totalCount nodes { author { login } body createdAt } }
  reviewRequests(first: 30) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
  latestReviews(first: 30) { nodes { author { login } state } }
  reviewThreads(first: 100) {
    totalCount
    nodes { isResolved isOutdated path line originalLine comments(first: 1) { totalCount nodes { author { login } body } } }
  }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { ${CHECK_FIELDS} } } } } } }`;

export class GitHubApi {
  private readonly endpoint: string;
  private readonly restBase: string;
  private readonly owner: string;
  private readonly name: string;

  constructor(
    host: string,
    project: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
  ) {
    this.endpoint = host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
    this.restBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
    const slash = project.lastIndexOf('/');
    this.owner = project.slice(0, slash);
    this.name = project.slice(slash + 1);
  }

  async viewer(): Promise<string> {
    const data = await this.query<{ viewer: { login: string } }>('query { viewer { login } }');
    return data.viewer.login;
  }

  async pullRequests(numbers: number[]): Promise<MergeRequestSummary[]> {
    const result: MergeRequestSummary[] = [];
    for (let i = 0; i < numbers.length; i += BATCH) {
      const chunk = numbers.slice(i, i + BATCH);
      const fields = chunk.map((n) => `p${n}: pullRequest(number: ${n}) { ${PR_FIELDS} }`).join('\n');
      const data = await this.repositoryQuery<Record<string, RawPullRequest | null>>(fields);
      for (const raw of Object.values(data)) if (raw) result.push(summary(raw));
    }
    return result;
  }

  /** Combined state of the checks of each commit; commits without checks are left out. */
  async checks(commits: string[]): Promise<Record<string, PipelineStatus>> {
    const result: Record<string, PipelineStatus> = {};
    for (let i = 0; i < commits.length; i += BATCH) {
      const chunk = commits.slice(i, i + BATCH);
      const fields = chunk
        .map((sha, j) => `c${j}: object(oid: "${sha}") { ... on Commit { statusCheckRollup { state } } }`)
        .join('\n');
      const data =
        await this.repositoryQuery<Record<string, { statusCheckRollup?: { state: string } | null } | null>>(
          fields,
        );
      chunk.forEach((sha, j) => {
        const state = data[`c${j}`]?.statusCheckRollup?.state;
        if (state && ROLLUP[state]) result[sha] = ROLLUP[state];
      });
    }
    return result;
  }

  /**
   * One page of merged pull requests, most recently updated first, with the commits they are known by: the
   * head of the branch and the merge (or squash) commit. `cursor` continues from the previous page.
   */
  async mergedPullRequests(cursor?: string): Promise<{ items: MergedMergeRequest[]; next?: string }> {
    const after = cursor ? `, after: ${JSON.stringify(cursor)}` : '';
    const data = await this.repositoryQuery<{
      pullRequests: { nodes: RawPullRequest[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    }>(
      `pullRequests(states: MERGED, orderBy: { field: UPDATED_AT, direction: DESC }, first: 100${after}) {
        nodes { ${PR_FIELDS} updatedAt headRefOid mergeCommit { oid } }
        pageInfo { hasNextPage endCursor }
      }`,
    );
    const page = data.pullRequests;
    return {
      items: page.nodes.map((raw) => ({
        ...summary(raw),
        commits: [raw.headRefOid, raw.mergeCommit?.oid].filter((c): c is string => !!c),
        updatedAt: Math.floor(Date.parse(raw.updatedAt ?? '') / 1000) || 0,
      })),
      next: page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined,
    };
  }

  /** Everything the card of a pull request shows, with the merge methods the repository allows. */
  async pullRequestCard(number: number): Promise<{
    card: RawPullRequestCard;
    viewer: string;
    methods: MergeMethod[];
  }> {
    const data = await this.query<{
      viewer: { login: string };
      repository: {
        pullRequest: RawPullRequestCard | null;
        mergeCommitAllowed: boolean;
        squashMergeAllowed: boolean;
        rebaseMergeAllowed: boolean;
      } | null;
    }>(
      `query($owner: String!, $name: String!) {
        viewer { login }
        repository(owner: $owner, name: $name) {
          mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
          pullRequest(number: ${number}) { ${CARD_FIELDS} }
        }
      }`,
      { owner: this.owner, name: this.name },
    );
    const repository = data.repository;
    if (!repository?.pullRequest) throw new GitHubApiError(`Pull request #${number} is not found`, 404);
    const methods: MergeMethod[] = [];
    if (repository.mergeCommitAllowed) methods.push('MERGE');
    if (repository.squashMergeAllowed) methods.push('SQUASH');
    if (repository.rebaseMergeAllowed) methods.push('REBASE');
    return { card: repository.pullRequest, viewer: data.viewer.login, methods };
  }

  async comment(pullRequestId: string, body: string): Promise<void> {
    await this.query(
      'mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { clientMutationId } }',
      {
        id: pullRequestId,
        body,
      },
    );
  }

  async approve(pullRequestId: string): Promise<void> {
    await this.query(
      'mutation($id: ID!) { addPullRequestReview(input: { pullRequestId: $id, event: APPROVE }) { clientMutationId } }',
      { id: pullRequestId },
    );
  }

  async merge(pullRequestId: string, method: MergeMethod, whenChecksPass: boolean): Promise<void> {
    const mutation = whenChecksPass ? 'enablePullRequestAutoMerge' : 'mergePullRequest';
    await this.query(
      `mutation($id: ID!, $method: PullRequestMergeMethod!) { ${mutation}(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId } }`,
      { id: pullRequestId, method },
    );
  }

  /** Brings the target branch into the pull request on the server, by a merge commit or a rebase. */
  async updateBranch(pullRequestId: string, method: 'MERGE' | 'REBASE'): Promise<void> {
    await this.query(
      'mutation($id: ID!, $method: PullRequestBranchUpdateMethod!) { updatePullRequestBranch(input: { pullRequestId: $id, updateMethod: $method }) { clientMutationId } }',
      { id: pullRequestId, method },
    );
  }

  /** Log of a GitHub Actions job: the id of its check run. */
  async jobLog(jobId: number): Promise<string> {
    const response = await this.rest('GET', `/actions/jobs/${jobId}/logs`);
    return response.text();
  }

  /** Runs the failed jobs of a GitHub Actions workflow run again. */
  async rerunFailedJobs(runId: number): Promise<void> {
    await this.rest('POST', `/actions/runs/${runId}/rerun-failed-jobs`);
  }

  private async rest(method: string, path: string) {
    const response = await this.fetchImpl(`${this.restBase}/repos/${this.owner}/${this.name}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'kleio',
      },
    });
    if (!response.ok)
      throw new GitHubApiError(`GitHub: ${response.status} ${await response.text()}`, response.status);
    return response;
  }

  private async repositoryQuery<T>(fields: string): Promise<T> {
    const data = await this.query<{ repository: T | null }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
      { owner: this.owner, name: this.name },
    );
    if (!data.repository) throw new GitHubApiError(`Repository ${this.owner}/${this.name} is not found`, 404);
    return data.repository;
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'kleio',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok)
      throw new GitHubApiError(`GitHub: ${response.status} ${await response.text()}`, response.status);
    const body = (await response.json()) as { data?: T; errors?: { message: string; type?: string }[] };
    // A missing pull request is an error of its alias only; the other aliases still have data.
    const fatal = body.errors?.filter((e) => e.type !== 'NOT_FOUND');
    if (!body.data || fatal?.length)
      throw new GitHubApiError(
        `GitHub: ${(fatal ?? body.errors ?? []).map((e) => e.message).join('; ')}`,
        400,
      );
    return body.data;
  }
}

function summary(raw: RawPullRequest): MergeRequestSummary {
  return {
    iid: raw.number,
    title: raw.title,
    state: raw.state === 'OPEN' ? 'opened' : raw.state === 'MERGED' ? 'merged' : 'closed',
    draft: raw.isDraft,
    webUrl: raw.url,
  };
}
