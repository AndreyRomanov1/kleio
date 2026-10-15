import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitLabApi, GitLabApiError } from '../src/extension/hosting/gitlabApi';

const requests: { method: string; url: string; auth?: string; body?: unknown }[] = [];
let server: Server;
let origin: string;

const routes: Record<string, unknown> = {
  '/api/v4/projects/group%2Fproject/merge_requests?state=merged&order_by=updated_at&sort=desc&per_page=100&page=2':
    [
      {
        iid: 5,
        title: 'squashed',
        state: 'merged',
        web_url: 'u5',
        sha: 'head5',
        squash_commit_sha: 'squash5',
        updated_at: '2026-01-02T00:00:00Z',
      },
      {
        iid: 4,
        title: 'merged',
        state: 'merged',
        web_url: 'u4',
        sha: 'head4',
        squash_commit_sha: null,
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
  '/api/v4/user': { name: 'Ann Smith', username: 'ann' },
  '/api/v4/projects/group%2Fproject/merge_requests?state=all&per_page=100&iids[]=7&iids[]=9': [
    { iid: 9, title: 'Draft: b', state: 'opened', draft: true, web_url: 'u9' },
    { iid: 7, title: 'a', state: 'merged', work_in_progress: false, web_url: 'u7' },
  ],
  '/api/v4/projects/group%2Fproject/merge_requests/9': {
    iid: 9,
    title: 'Draft: b',
    state: 'opened',
    draft: true,
    web_url: 'u9',
    author: { name: 'Ann Smith', username: 'ann' },
    reviewers: [{ name: 'Bob', username: 'bob' }],
    source_branch: 'feature',
    target_branch: 'master',
    has_conflicts: false,
    detailed_merge_status: 'not_approved',
    user_notes_count: 3,
    head_pipeline: { id: 50, status: 'failed', web_url: 'p50' },
  },
  '/api/v4/projects/group%2Fproject/merge_requests/9/approvals': {
    approved_by: [{ user: { name: 'Bob', username: 'bob' } }],
    approvals_required: 2,
    approvals_left: 1,
  },
  '/api/v4/projects/group%2Fproject/merge_requests/9/discussions?per_page=100&page=1': [
    {
      id: 'd1',
      individual_note: false,
      notes: [
        {
          id: 1,
          body: 'why?',
          author: { name: 'Bob', username: 'bob' },
          created_at: '2026-10-14T10:00:00Z',
          resolvable: true,
          resolved: false,
          position: {
            base_sha: 'b',
            start_sha: 's',
            head_sha: 'h',
            old_path: 'a.cs',
            new_path: 'a.cs',
            old_line: null,
            new_line: 12,
          },
        },
      ],
    },
    {
      id: 'd2',
      individual_note: true,
      notes: [
        {
          id: 2,
          body: 'added 1 commit',
          author: { name: 'Ann', username: 'ann' },
          created_at: 'x',
          system: true,
        },
      ],
    },
  ],
  '/api/v4/projects/group%2Fproject/merge_requests/9/draft_notes': [
    {
      id: 5,
      note: 'draft',
      discussion_id: null,
      position: {
        base_sha: 'b',
        start_sha: 's',
        head_sha: 'h',
        old_path: 'a.cs',
        new_path: 'a.cs',
        old_line: 3,
        new_line: 4,
      },
    },
  ],
  '/api/v4/projects/group%2Fproject/pipelines?per_page=100&order_by=id&sort=desc': [
    { id: 52, sha: 'aaa', status: 'running' },
    { id: 51, sha: 'aaa', status: 'failed' },
    { id: 50, sha: 'bbb', status: 'success' },
  ],
  '/api/v4/projects/group%2Fproject/pipelines/50/jobs?per_page=100&include_retried=false': [
    {
      id: 102,
      name: 'test',
      stage: 'test',
      status: 'failed',
      duration: 61.5,
      web_url: 'j102',
      allow_failure: false,
    },
    { id: 101, name: 'build', stage: 'build', status: 'success', duration: 30, web_url: 'j101' },
  ],
};

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({
      method: req.method!,
      url: req.url!,
      auth: req.headers.authorization,
      body: text ? JSON.parse(text) : undefined,
    });
    if (req.headers.authorization !== 'Bearer secret') {
      res.statusCode = 401;
      res.end('{"message":"401 Unauthorized"}');
      return;
    }
    if (req.url === '/api/v4/projects/group%2Fproject/jobs/102/trace') {
      res.end('log line\n');
      return;
    }
    if (req.method !== 'GET') {
      res.statusCode = 201;
      res.end('{}');
      return;
    }
    const body = routes[req.url!];
    res.statusCode = body ? 200 : 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body ?? { message: '404 Not Found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const api = (token = 'secret') => new GitLabApi('git.example.com', 'group/project', token, fetch, origin);

describe('GitLabApi', () => {
  it('sends the token as a bearer token and reads the current user', async () => {
    expect(await api().currentUser()).toEqual({ name: 'Ann Smith', username: 'ann' });
    expect(requests.at(-1)?.auth).toBe('Bearer secret');
  });

  it('reports a rejected token as unauthorized', async () => {
    const error = await api('wrong')
      .currentUser()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect((error as GitLabApiError).unauthorized).toBe(true);
  });

  it('reads summaries of several merge requests in one request', async () => {
    expect(await api().mergeRequests([7, 9])).toEqual([
      { iid: 9, title: 'Draft: b', state: 'opened', draft: true, webUrl: 'u9' },
      { iid: 7, title: 'a', state: 'merged', draft: false, webUrl: 'u7' },
    ]);
  });

  it('reads merge request details, approvals and pipeline jobs', async () => {
    const details = await api().mergeRequest(9);
    expect(details).toMatchObject({
      reviewers: [{ name: 'Bob', username: 'bob' }],
      mergeStatus: 'not_approved',
      userNotesCount: 3,
      pipeline: { id: 50, status: 'failed', webUrl: 'p50' },
    });
    expect(await api().approvals(9)).toEqual({
      approvedBy: [{ name: 'Bob', username: 'bob' }],
      required: 2,
      left: 1,
    });
    expect((await api().jobs(50)).map((j) => [j.name, j.status, j.duration])).toEqual([
      ['build', 'success', 30],
      ['test', 'failed', 61.5],
    ]);
    expect(await api().jobLog(102)).toBe('log line\n');
  });

  it('keeps the latest pipeline of each commit', async () => {
    expect(await api().latestPipelines()).toEqual({ aaa: 'running', bbb: 'success' });
  });

  it('retries a pipeline with POST', async () => {
    await api().retryPipeline(50);
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/v4/projects/group%2Fproject/pipelines/50/retry',
    });
  });

  it('reads discussions and draft notes with their diff positions', async () => {
    const [thread, system] = await api().discussions(9);
    expect(thread).toMatchObject({ id: 'd1', individual: false });
    expect(thread.notes[0]).toMatchObject({
      body: 'why?',
      resolvable: true,
      resolved: false,
      position: { newLine: 12, oldLine: undefined },
    });
    expect(system.notes[0].system).toBe(true);
    expect(await api().draftNotes(9)).toEqual([
      {
        id: 5,
        body: 'draft',
        discussionId: undefined,
        position: {
          baseSha: 'b',
          startSha: 's',
          headSha: 'h',
          oldPath: 'a.cs',
          newPath: 'a.cs',
          oldLine: 3,
          newLine: 4,
        },
      },
    ]);
  });

  it('creates threads, replies, drafts and resolves with the bodies GitLab expects', async () => {
    const position = {
      baseSha: 'b',
      startSha: 's',
      headSha: 'h',
      oldPath: 'a.cs',
      newPath: 'a.cs',
      newLine: 7,
    };
    await api().createDiscussion(9, 'line comment', position);
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/v4/projects/group%2Fproject/merge_requests/9/discussions',
      body: {
        body: 'line comment',
        position: {
          position_type: 'text',
          base_sha: 'b',
          start_sha: 's',
          head_sha: 'h',
          old_path: 'a.cs',
          new_path: 'a.cs',
          new_line: 7,
        },
      },
    });
    await api().createDiscussion(9, 'general');
    expect(requests.at(-1)?.body).toEqual({ body: 'general' });
    await api().createDraftNote(9, 'later', { discussionId: 'd1' });
    expect(requests.at(-1)).toMatchObject({
      url: '/api/v4/projects/group%2Fproject/merge_requests/9/draft_notes',
      body: { note: 'later', in_reply_to_discussion_id: 'd1' },
    });
    await api().publishDraftNotes(9);
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/v4/projects/group%2Fproject/merge_requests/9/draft_notes/bulk_publish',
    });
    await api().resolve(9, 'd1', true);
    expect(requests.at(-1)).toMatchObject({
      method: 'PUT',
      url: '/api/v4/projects/group%2Fproject/merge_requests/9/discussions/d1?resolved=true',
    });
  });

  it('sends a comment on several lines with the line range GitLab expects', async () => {
    await api().createDiscussion(9, 'range', {
      baseSha: 'b',
      startSha: 's',
      headSha: 'h',
      oldPath: 'a.cs',
      newPath: 'a.cs',
      newLine: 9,
      lineRange: {
        start: { oldLine: 5, newLine: 6, counters: { old: 5, new: 6 } },
        end: { newLine: 9, counters: { old: 8, new: 9 } },
      },
    });
    const hash = createHash('sha1').update('a.cs').digest('hex');
    expect(requests.at(-1)?.body).toMatchObject({
      position: {
        new_line: 9,
        line_range: {
          start: { line_code: `${hash}_5_6`, type: 'old', old_line: 5, new_line: 6 },
          end: { line_code: `${hash}_8_9`, type: 'new', old_line: null, new_line: 9 },
        },
      },
    });
  });

  it('approves, merges, rebases and plays jobs with the requests GitLab expects', async () => {
    await api().approve(9);
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/v4/projects/group%2Fproject/merge_requests/9/approve',
    });
    await api().unapprove(9);
    expect(requests.at(-1)?.url).toBe('/api/v4/projects/group%2Fproject/merge_requests/9/unapprove');
    await api().merge(9, { whenPipelineSucceeds: true });
    expect(requests.at(-1)).toMatchObject({
      method: 'PUT',
      url: '/api/v4/projects/group%2Fproject/merge_requests/9/merge',
      body: { merge_when_pipeline_succeeds: true, auto_merge: true },
    });
    await api().merge(9, { whenPipelineSucceeds: false });
    expect(requests.at(-1)?.body).toEqual({});
    await api().rebase(9);
    expect(requests.at(-1)).toMatchObject({
      method: 'PUT',
      url: '/api/v4/projects/group%2Fproject/merge_requests/9/rebase',
    });
    await api().playJob(77, 3146);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', url: '/api/v4/projects/3146/jobs/77/play' });
  });

  it('pages through merged merge requests with the commits they are known by', async () => {
    const page = await api().mergedMergeRequests(2);
    expect(page.last).toBe(true);
    expect(page.items.map((m) => [m.iid, m.commits, m.updatedAt])).toEqual([
      [5, ['head5', 'squash5'], Date.parse('2026-01-02T00:00:00Z') / 1000],
      [4, ['head4'], Date.parse('2026-01-01T00:00:00Z') / 1000],
    ]);
  });
});
