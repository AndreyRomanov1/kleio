import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitLabApi, GitLabApiError } from '../src/extension/hosting/gitlabApi';

const requests: { method: string; url: string; auth?: string }[] = [];
let server: Server;
let origin: string;

const routes: Record<string, unknown> = {
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
  server = createServer((req: IncomingMessage, res) => {
    requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer secret') {
      res.statusCode = 401;
      res.end('{"message":"401 Unauthorized"}');
      return;
    }
    if (req.url === '/api/v4/projects/group%2Fproject/jobs/102/trace') {
      res.end('log line\n');
      return;
    }
    if (req.method === 'POST') {
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
});
