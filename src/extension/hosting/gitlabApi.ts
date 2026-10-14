/** A small GitLab REST v4 client: only what Grove shows, every call scoped to one project. */

export type PipelineStatus =
  | 'created'
  | 'waiting_for_resource'
  | 'preparing'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual'
  | 'scheduled';

export interface MergeRequestSummary {
  iid: number;
  title: string;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  draft: boolean;
  webUrl: string;
}

export interface Person {
  name: string;
  username: string;
}

export interface Job {
  id: number;
  name: string;
  stage: string;
  status: PipelineStatus;
  /** Seconds, absent until the job finishes. */
  duration?: number;
  webUrl: string;
  allowFailure: boolean;
}

export interface MergeRequestDetails extends MergeRequestSummary {
  author: Person;
  reviewers: Person[];
  sourceBranch: string;
  targetBranch: string;
  hasConflicts: boolean;
  /** GitLab's merge readiness, e.g. `mergeable`, `not_approved`, `ci_still_running`. */
  mergeStatus?: string;
  userNotesCount: number;
  pipeline?: { id: number; status: PipelineStatus; webUrl: string };
}

export interface Approvals {
  approvedBy: Person[];
  required: number;
  left: number;
}

export class GitLabApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

type Fetch = typeof fetch;

export class GitLabApi {
  private readonly base: string;

  constructor(
    host: string,
    private readonly project: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
    /** For tests: the scheme and port of a fake server. */
    origin = `https://${host}`,
  ) {
    this.base = `${origin}/api/v4`;
  }

  private get projectPath(): string {
    return `/projects/${encodeURIComponent(this.project)}`;
  }

  async currentUser(): Promise<Person> {
    return person(await this.get<RawPerson>('/user'));
  }

  /** Summaries of the given merge requests in one request (GitLab accepts up to 100 iids). */
  async mergeRequests(iids: number[]): Promise<MergeRequestSummary[]> {
    if (iids.length === 0) return [];
    const query = iids
      .slice(0, 100)
      .map((iid) => `iids[]=${iid}`)
      .join('&');
    const raw = await this.get<RawMergeRequest[]>(
      `${this.projectPath}/merge_requests?state=all&per_page=100&${query}`,
    );
    return raw.map(summary);
  }

  async mergeRequest(iid: number): Promise<MergeRequestDetails> {
    const raw = await this.get<RawMergeRequest>(`${this.projectPath}/merge_requests/${iid}`);
    return {
      ...summary(raw),
      author: person(raw.author),
      reviewers: (raw.reviewers ?? []).map(person),
      sourceBranch: raw.source_branch,
      targetBranch: raw.target_branch,
      hasConflicts: !!raw.has_conflicts,
      mergeStatus: raw.detailed_merge_status ?? raw.merge_status,
      userNotesCount: raw.user_notes_count ?? 0,
      pipeline: raw.head_pipeline
        ? { id: raw.head_pipeline.id, status: raw.head_pipeline.status, webUrl: raw.head_pipeline.web_url }
        : undefined,
    };
  }

  async approvals(iid: number): Promise<Approvals> {
    const raw = await this.get<RawApprovals>(`${this.projectPath}/merge_requests/${iid}/approvals`);
    return {
      approvedBy: (raw.approved_by ?? []).map((a) => person(a.user)),
      required: raw.approvals_required ?? 0,
      left: raw.approvals_left ?? 0,
    };
  }

  /** Status of the latest pipeline of each commit among the project's recent pipelines. */
  async latestPipelines(): Promise<Record<string, PipelineStatus>> {
    const raw = await this.get<RawPipeline[]>(
      `${this.projectPath}/pipelines?per_page=100&order_by=id&sort=desc`,
    );
    const bySha: Record<string, PipelineStatus> = {};
    for (const pipeline of raw) bySha[pipeline.sha] ??= pipeline.status;
    return bySha;
  }

  async jobs(pipelineId: number): Promise<Job[]> {
    const raw = await this.get<RawJob[]>(
      `${this.projectPath}/pipelines/${pipelineId}/jobs?per_page=100&include_retried=false`,
    );
    return raw
      .map((j) => ({
        id: j.id,
        name: j.name,
        stage: j.stage,
        status: j.status,
        duration: j.duration ?? undefined,
        webUrl: j.web_url,
        allowFailure: !!j.allow_failure,
      }))
      .sort((a, b) => a.id - b.id);
  }

  async jobLog(jobId: number): Promise<string> {
    return this.request(`${this.projectPath}/jobs/${jobId}/trace`, 'GET').then((r) => r.text());
  }

  async retryPipeline(pipelineId: number): Promise<void> {
    await this.request(`${this.projectPath}/pipelines/${pipelineId}/retry`, 'POST');
  }

  async retryJob(jobId: number): Promise<void> {
    await this.request(`${this.projectPath}/jobs/${jobId}/retry`, 'POST');
  }

  private async get<T>(path: string): Promise<T> {
    return (await (await this.request(path, 'GET')).json()) as T;
  }

  private async request(path: string, method: 'GET' | 'POST'): Promise<Response> {
    // Bearer works for both personal access tokens and OAuth tokens (GitLab Workflow's gitlab.com accounts).
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GitLabApiError(response.status, `GitLab ${response.status}: ${text.slice(0, 200)}`);
    }
    return response;
  }
}

interface RawPerson {
  name: string;
  username: string;
}

interface RawMergeRequest {
  iid: number;
  title: string;
  state: MergeRequestSummary['state'];
  draft?: boolean;
  work_in_progress?: boolean;
  web_url: string;
  author: RawPerson;
  reviewers?: RawPerson[];
  source_branch: string;
  target_branch: string;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  merge_status?: string;
  user_notes_count?: number;
  head_pipeline?: { id: number; status: PipelineStatus; web_url: string } | null;
}

interface RawApprovals {
  approved_by?: { user: RawPerson }[];
  approvals_required?: number;
  approvals_left?: number;
}

interface RawPipeline {
  id: number;
  sha: string;
  status: PipelineStatus;
}

interface RawJob {
  id: number;
  name: string;
  stage: string;
  status: PipelineStatus;
  duration?: number | null;
  web_url: string;
  allow_failure?: boolean;
}

function person(raw: RawPerson): Person {
  return { name: raw.name, username: raw.username };
}

function summary(raw: RawMergeRequest): MergeRequestSummary {
  return {
    iid: raw.iid,
    title: raw.title,
    state: raw.state,
    draft: !!(raw.draft ?? raw.work_in_progress),
    webUrl: raw.web_url,
  };
}
