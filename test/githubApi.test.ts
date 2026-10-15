import { describe, expect, it } from 'vitest';
import { GitHubApi, GitHubApiError } from '../src/extension/hosting/githubApi';

interface Call {
  url: string;
  query: string;
  variables: Record<string, unknown>;
  auth: string;
}

function fakeFetch(respond: (query: string) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    const { query, variables } = JSON.parse(init.body ?? '{}') as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push({ url, query, variables, auth: init.headers.Authorization });
    const { status = 200, body } = respond(query);
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { calls, impl };
}

describe('GitHubApi', () => {
  it('reads pull requests of a hundred numbers in one query and skips missing ones', async () => {
    const { calls, impl } = fakeFetch(() => ({
      body: {
        data: {
          repository: {
            p12: {
              number: 12,
              title: 'Fix',
              state: 'MERGED',
              isDraft: false,
              url: 'https://github.com/o/r/pull/12',
            },
            p13: {
              number: 13,
              title: 'WIP',
              state: 'OPEN',
              isDraft: true,
              url: 'https://github.com/o/r/pull/13',
            },
            p14: null,
          },
        },
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest with the number of 14.' }],
      },
    }));
    const api = new GitHubApi('github.com', 'o/r', 'secret', impl);

    const prs = await api.pullRequests([12, 13, 14]);

    expect(prs).toEqual([
      { iid: 12, title: 'Fix', state: 'merged', draft: false, webUrl: 'https://github.com/o/r/pull/12' },
      { iid: 13, title: 'WIP', state: 'opened', draft: true, webUrl: 'https://github.com/o/r/pull/13' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/graphql');
    expect(calls[0].auth).toBe('Bearer secret');
    expect(calls[0].variables).toEqual({ owner: 'o', name: 'r' });
    expect(calls[0].query).toContain('p14: pullRequest(number: 14)');
  });

  it('maps the combined checks of commits to pipeline statuses', async () => {
    const { calls, impl } = fakeFetch(() => ({
      body: {
        data: {
          repository: {
            c0: { statusCheckRollup: { state: 'SUCCESS' } },
            c1: { statusCheckRollup: { state: 'FAILURE' } },
            c2: { statusCheckRollup: null },
          },
        },
      },
    }));
    const api = new GitHubApi('git.example.com', 'group/o/r', 'secret', impl);

    expect(await api.checks(['a1', 'b2', 'c3'])).toEqual({ a1: 'success', b2: 'failed' });
    expect(calls[0].url).toBe('https://git.example.com/api/graphql');
    expect(calls[0].variables).toEqual({ owner: 'group/o', name: 'r' });
  });

  it('pages merged pull requests with the commits they are known by', async () => {
    const { calls, impl } = fakeFetch(() => ({
      body: {
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 7,
                  title: 'Feature',
                  state: 'MERGED',
                  isDraft: false,
                  url: 'u',
                  updatedAt: '2026-10-01T10:00:00Z',
                  headRefOid: 'head7',
                  mergeCommit: { oid: 'merge7' },
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'CUR' },
            },
          },
        },
      },
    }));
    const api = new GitHubApi('github.com', 'o/r', 'secret', impl);

    const page = await api.mergedPullRequests('PREV');

    expect(page.next).toBe('CUR');
    expect(page.items[0]).toMatchObject({ iid: 7, state: 'merged', commits: ['head7', 'merge7'] });
    expect(page.items[0].updatedAt).toBe(Date.parse('2026-10-01T10:00:00Z') / 1000);
    expect(calls[0].query).toContain('after: "PREV"');
  });

  it('reports a rejected token as unauthorized', async () => {
    const { impl } = fakeFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    const api = new GitHubApi('github.com', 'o/r', 'bad', impl);

    const error = await api.viewer().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).unauthorized).toBe(true);
  });
});
