import { createHash } from 'node:crypto';

/** A small GitLab REST v4 client: only what Kleio shows, every call scoped to one project. */

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

export interface MergedMergeRequest extends MergeRequestSummary {
  /** Commits the merge request shows up at in the history. */
  commits: string[];
  /** Unix time, seconds. */
  updatedAt: number;
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

export interface Bridge extends Job {
  /** The child pipeline, once the trigger job has run. */
  downstream?: { id: number; status: PipelineStatus; webUrl: string; projectId: number };
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
  diffRefs?: DiffRefs;
}

export interface Approvals {
  approvedBy: Person[];
  required: number;
  left: number;
}

/** A place in a merge request diff: GitLab needs the versions of both sides and the line on one or both of them. */
export interface DiffPosition {
  baseSha: string;
  startSha: string;
  headSha: string;
  oldPath: string;
  newPath: string;
  /** 1-based; set for removed and unchanged lines. */
  oldLine?: number;
  /** 1-based; set for added and unchanged lines. */
  newLine?: number;
  /** For a comment on several lines: its first and last line; `oldLine` and `newLine` are those of the last. */
  lineRange?: { start: LineEnd; end: LineEnd };
}

/** An end of a multi-line comment: the line on its side and both counters GitLab keeps for it. */
export interface LineEnd {
  oldLine?: number;
  newLine?: number;
  counters: { old: number; new: number };
}

export interface Note {
  id: number;
  body: string;
  author: Person;
  /** ISO time. */
  createdAt: string;
  /** Notes GitLab writes itself, e.g. "added 2 commits". */
  system: boolean;
  resolvable: boolean;
  resolved: boolean;
  position?: DiffPosition;
}

export interface Discussion {
  id: string;
  /** A single comment that cannot be replied to as a thread. */
  individual: boolean;
  notes: Note[];
}

export interface DraftNote {
  id: number;
  body: string;
  /** The thread a draft reply belongs to. */
  discussionId?: string;
  position?: DiffPosition;
}

export interface DiffRefs {
  baseSha: string;
  startSha: string;
  headSha: string;
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

/**
 * The client for a project. Integration tests point it to a fake server with KLEIO_TEST_GITLAB_ORIGIN (and give a
 * token with KLEIO_TEST_GITLAB_TOKEN); otherwise it is `https://<host>`.
 */
export function createGitLabApi(host: string, project: string, token: string): GitLabApi {
  return new GitLabApi(
    host,
    project,
    token,
    fetch,
    process.env.KLEIO_TEST_GITLAB_ORIGIN ?? `https://${host}`,
  );
}

export class GitLabApi {
  private readonly base: string;

  constructor(
    readonly host: string,
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

  /**
   * One page of merged merge requests, most recently updated first, with the commits they are known by: the
   * head of the branch and the squash commit. A merge request is updated no earlier than it is merged, so the
   * pages go back in time by merge date as well.
   */
  async mergedMergeRequests(page: number): Promise<{ items: MergedMergeRequest[]; last: boolean }> {
    const raw = await this.get<RawMergeRequest[]>(
      `${this.projectPath}/merge_requests?state=merged&order_by=updated_at&sort=desc&per_page=100&page=${page}`,
    );
    return {
      items: raw.map((r) => ({
        ...summary(r),
        commits: [r.sha, r.squash_commit_sha].filter((c): c is string => !!c),
        updatedAt: Math.floor(Date.parse(r.updated_at ?? '') / 1000) || 0,
      })),
      last: raw.length < 100,
    };
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
      diffRefs: raw.diff_refs
        ? {
            baseSha: raw.diff_refs.base_sha,
            startSha: raw.diff_refs.start_sha,
            headSha: raw.diff_refs.head_sha,
          }
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

  /** Jobs of a pipeline; `projectId` for a child pipeline that runs in another project. */
  async jobs(pipelineId: number, projectId?: number): Promise<Job[]> {
    const raw = await this.get<RawJob[]>(
      `${this.projectRef(projectId)}/pipelines/${pipelineId}/jobs?per_page=100&include_retried=false`,
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

  async jobLog(jobId: number, projectId?: number): Promise<string> {
    return this.request(`${this.projectRef(projectId)}/jobs/${jobId}/trace`, 'GET').then((r) => r.text());
  }

  /** Trigger jobs of a pipeline, which GitLab lists apart from the other jobs; they start child pipelines. */
  async bridges(pipelineId: number): Promise<Bridge[]> {
    const raw = await this.get<RawBridge[]>(
      `${this.projectPath}/pipelines/${pipelineId}/bridges?per_page=100`,
    );
    return raw
      .map((b) => ({
        id: b.id,
        name: b.name,
        stage: b.stage,
        status: b.status,
        duration: b.duration ?? undefined,
        webUrl: b.web_url,
        allowFailure: !!b.allow_failure,
        downstream: b.downstream_pipeline
          ? {
              id: b.downstream_pipeline.id,
              status: b.downstream_pipeline.status,
              webUrl: b.downstream_pipeline.web_url,
              projectId: b.downstream_pipeline.project_id,
            }
          : undefined,
      }))
      .sort((a, b) => a.id - b.id);
  }

  private projectRef(projectId: number | undefined): string {
    return projectId === undefined ? this.projectPath : `/projects/${projectId}`;
  }

  async retryPipeline(pipelineId: number): Promise<void> {
    await this.request(`${this.projectPath}/pipelines/${pipelineId}/retry`, 'POST');
  }

  async retryJob(jobId: number): Promise<void> {
    await this.request(`${this.projectPath}/jobs/${jobId}/retry`, 'POST');
  }

  /** Starts a manual job, including trigger jobs that start child pipelines (e.g. deploys run by hand). */
  async playJob(jobId: number, projectId?: number): Promise<void> {
    await this.request(`${this.projectRef(projectId)}/jobs/${jobId}/play`, 'POST');
  }

  async approve(iid: number): Promise<void> {
    await this.request(`${this.projectPath}/merge_requests/${iid}/approve`, 'POST');
  }

  async unapprove(iid: number): Promise<void> {
    await this.request(`${this.projectPath}/merge_requests/${iid}/unapprove`, 'POST');
  }

  /**
   * Merges now, or with `whenPipelineSucceeds` sets auto-merge after the running pipeline. Squash and removing
   * the source branch follow what is set on the merge request.
   */
  async merge(iid: number, options: { whenPipelineSucceeds: boolean }): Promise<void> {
    await this.request(`${this.projectPath}/merge_requests/${iid}/merge`, 'PUT', {
      ...(options.whenPipelineSucceeds ? { merge_when_pipeline_succeeds: true, auto_merge: true } : {}),
    });
  }

  /** Rebases the source branch onto the target on the server, as the Rebase button on the web. */
  async rebase(iid: number): Promise<void> {
    await this.request(`${this.projectPath}/merge_requests/${iid}/rebase`, 'PUT');
  }

  async discussions(iid: number): Promise<Discussion[]> {
    const raw: RawDiscussion[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.get<RawDiscussion[]>(
        `${this.projectPath}/merge_requests/${iid}/discussions?per_page=100&page=${page}`,
      );
      raw.push(...batch);
      if (batch.length < 100) break;
    }
    return raw.map((d) => ({
      id: d.id,
      individual: !!d.individual_note,
      notes: d.notes.map(note),
    }));
  }

  /** A new thread, on a diff line when `position` is given, otherwise on the merge request as a whole. */
  async createDiscussion(iid: number, body: string, position?: DiffPosition): Promise<void> {
    await this.request(`${this.projectPath}/merge_requests/${iid}/discussions`, 'POST', {
      body,
      ...(position ? { position: rawPosition(position) } : {}),
    });
  }

  async reply(iid: number, discussionId: string, body: string): Promise<void> {
    await this.request(
      `${this.projectPath}/merge_requests/${iid}/discussions/${discussionId}/notes`,
      'POST',
      {
        body,
      },
    );
  }

  async resolve(iid: number, discussionId: string, resolved: boolean): Promise<void> {
    await this.request(
      `${this.projectPath}/merge_requests/${iid}/discussions/${discussionId}?resolved=${resolved}`,
      'PUT',
    );
  }

  async draftNotes(iid: number): Promise<DraftNote[]> {
    const raw = await this.get<RawDraftNote[]>(`${this.projectPath}/merge_requests/${iid}/draft_notes`);
    return raw.map((d) => ({
      id: d.id,
      body: d.note,
      discussionId: d.discussion_id ?? undefined,
      position: d.position ? position(d.position) : undefined,
    }));
  }

  /**
   * A pending comment, stored by GitLab and published together with the others ("Submit review" on the web).
   * `discussionId` makes it a reply.
   */
  async createDraftNote(
    iid: number,
    body: string,
    target: { position?: DiffPosition; discussionId?: string },
  ): Promise<void> {
    await this.request(`${this.projectPath}/merge_requests/${iid}/draft_notes`, 'POST', {
      note: body,
      ...(target.position ? { position: rawPosition(target.position) } : {}),
      ...(target.discussionId ? { in_reply_to_discussion_id: target.discussionId } : {}),
    });
  }

  async deleteDraftNote(iid: number, id: number): Promise<void> {
    await this.request(`${this.projectPath}/merge_requests/${iid}/draft_notes/${id}`, 'DELETE');
  }

  async publishDraftNotes(iid: number): Promise<void> {
    await this.request(`${this.projectPath}/merge_requests/${iid}/draft_notes/bulk_publish`, 'POST');
  }

  private async get<T>(path: string): Promise<T> {
    return (await (await this.request(path, 'GET')).json()) as T;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<Response> {
    // Bearer works for both personal access tokens and OAuth tokens (GitLab Workflow's gitlab.com accounts).
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GitLabApiError(response.status, `GitLab ${response.status}: ${text.slice(0, 200)}`);
    }
    return response;
  }
}

interface RawBridge extends RawJob {
  downstream_pipeline?: { id: number; status: PipelineStatus; web_url: string; project_id: number } | null;
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
  diff_refs?: { base_sha: string; start_sha: string; head_sha: string } | null;
  sha?: string;
  squash_commit_sha?: string | null;
  updated_at?: string;
}

interface RawPosition {
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
  old_line?: number | null;
  new_line?: number | null;
  position_type?: string;
  line_range?: { start: RawLineEnd; end: RawLineEnd } | null;
}

interface RawLineEnd {
  line_code?: string;
  type?: 'new' | 'old' | null;
  old_line?: number | null;
  new_line?: number | null;
}

interface RawNote {
  id: number;
  body: string;
  author: RawPerson;
  created_at: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: RawPosition | null;
}

interface RawDiscussion {
  id: string;
  individual_note?: boolean;
  notes: RawNote[];
}

interface RawDraftNote {
  id: number;
  note: string;
  discussion_id?: string | null;
  position?: RawPosition | null;
}

function position(raw: RawPosition): DiffPosition {
  return {
    baseSha: raw.base_sha,
    startSha: raw.start_sha,
    headSha: raw.head_sha,
    oldPath: raw.old_path,
    newPath: raw.new_path,
    oldLine: raw.old_line ?? undefined,
    newLine: raw.new_line ?? undefined,
    lineRange: raw.line_range
      ? { start: lineEnd(raw.line_range.start), end: lineEnd(raw.line_range.end) }
      : undefined,
  };
}

function lineEnd(raw: RawLineEnd): LineEnd {
  const oldLine = raw.old_line ?? undefined;
  const newLine = raw.new_line ?? undefined;
  return { oldLine, newLine, counters: { old: oldLine ?? 0, new: newLine ?? 0 } };
}

/** As GitLab names a diff line: the SHA-1 of the file path and both counters of the line. */
function rawLineEnd(path: string, end: LineEnd): RawLineEnd {
  const hash = createHash('sha1').update(path).digest('hex');
  return {
    line_code: `${hash}_${end.counters.old}_${end.counters.new}`,
    type: end.oldLine === undefined ? 'new' : 'old',
    old_line: end.oldLine ?? null,
    new_line: end.newLine ?? null,
  };
}

function rawPosition(p: DiffPosition): RawPosition {
  return {
    position_type: 'text',
    base_sha: p.baseSha,
    start_sha: p.startSha,
    head_sha: p.headSha,
    old_path: p.oldPath,
    new_path: p.newPath,
    ...(p.oldLine !== undefined ? { old_line: p.oldLine } : {}),
    ...(p.newLine !== undefined ? { new_line: p.newLine } : {}),
    ...(p.lineRange
      ? {
          line_range: {
            start: rawLineEnd(p.newPath, p.lineRange.start),
            end: rawLineEnd(p.newPath, p.lineRange.end),
          },
        }
      : {}),
  };
}

function note(raw: RawNote): Note {
  return {
    id: raw.id,
    body: raw.body,
    author: person(raw.author),
    createdAt: raw.created_at,
    system: !!raw.system,
    resolvable: !!raw.resolvable,
    resolved: !!raw.resolved,
    position: raw.position ? position(raw.position) : undefined,
  };
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
