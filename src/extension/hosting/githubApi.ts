import type { MergedMergeRequest, MergeRequestSummary, PipelineStatus } from './gitlabApi';

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
  init: { method: string; headers: Record<string, string>; body: string },
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
export class GitHubApi {
  private readonly endpoint: string;
  private readonly owner: string;
  private readonly name: string;

  constructor(
    host: string,
    project: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
  ) {
    this.endpoint = host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
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
