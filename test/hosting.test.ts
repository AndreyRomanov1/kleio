import { describe, expect, it } from 'vitest';
import {
  detectHosting,
  HostingLinks,
  parseRemoteUrl,
  parseReviewRefs,
} from '../src/extension/hosting/hosting';

describe('parseRemoteUrl', () => {
  it.each([
    ['git@git.example.com:acme/shop.git', 'git.example.com', 'acme/shop'],
    ['ssh://git@git.example.com:2222/group/sub/project.git', 'git.example.com', 'group/sub/project'],
    ['https://gitlab.com/group/project.git', 'gitlab.com', 'group/project'],
    ['https://user:secret@github.com/owner/repo', 'github.com', 'owner/repo'],
    ['git@github.com:owner/repo', 'github.com', 'owner/repo'],
  ])('%s', (url, host, project) => {
    expect(parseRemoteUrl(url)).toEqual({ host, project, webUrl: `https://${host}/${project}` });
  });

  it('rejects local paths and URLs without a project', () => {
    expect(parseRemoteUrl('/srv/git/repo.git')).toBeUndefined();
    expect(parseRemoteUrl('file:///srv/git/repo.git')).toBeUndefined();
    expect(parseRemoteUrl('https://example.com/repo.git')).toBeUndefined();
  });
});

describe('detectHosting', () => {
  const remote = parseRemoteUrl('git@git.example.com:g/p.git')!;
  const none = { mergeRequests: false, pullRequests: false };

  it('prefers settings, then well-known hosts, then review refs exposed by the server', () => {
    expect(
      detectHosting(remote, { 'git.example.com': 'github' }, { mergeRequests: true, pullRequests: false }),
    ).toBe('github');
    expect(detectHosting(parseRemoteUrl('git@github.com:o/r.git')!, {}, none)).toBe('github');
    expect(detectHosting(remote, {}, { mergeRequests: true, pullRequests: false })).toBe('gitlab');
    expect(detectHosting(remote, {}, none)).toBeUndefined();
  });
});

describe('HostingLinks', () => {
  const gitlab = new HostingLinks('gitlab', parseRemoteUrl('git@git.example.com:acme/shop.git')!);
  const github = new HostingLinks('github', parseRemoteUrl('git@github.com:owner/repo.git')!);

  it('builds GitLab links', () => {
    const base = 'https://git.example.com/acme/shop/-';
    expect(gitlab.commit('abc')).toBe(`${base}/commit/abc`);
    expect(gitlab.branch('feature/x y')).toBe(`${base}/tree/feature/x%20y`);
    expect(gitlab.file('abc', 'src/a.cs', { start: 3, end: 7 })).toBe(`${base}/blob/abc/src/a.cs#L3-7`);
    expect(gitlab.file('abc', 'src/a.cs', { start: 3, end: 3 })).toBe(`${base}/blob/abc/src/a.cs#L3`);
    expect(gitlab.mergeRequest(1814)).toBe(`${base}/merge_requests/1814`);
    expect(gitlab.newMergeRequest('PROJ-1', 'master')).toBe(
      `${base}/merge_requests/new?merge_request%5Bsource_branch%5D=PROJ-1&merge_request%5Btarget_branch%5D=master`,
    );
  });

  it('builds GitHub links', () => {
    expect(github.file('abc', 'a.ts', { start: 1, end: 2 })).toBe(
      'https://github.com/owner/repo/blob/abc/a.ts#L1-L2',
    );
    expect(github.mergeRequest(5)).toBe('https://github.com/owner/repo/pull/5');
    expect(github.newMergeRequest('feat', 'main')).toBe(
      'https://github.com/owner/repo/compare/main...feat?expand=1',
    );
  });

  it('autolinks merge requests and issues', () => {
    const [mr, issue] = gitlab.builtinAutolinks();
    expect('see !1814, not a!1'.replace(new RegExp(mr.pattern, 'g'), mr.url)).toBe(
      'see https://git.example.com/acme/shop/-/merge_requests/1814, not a!1',
    );
    expect('fixes #12 and &#13'.replace(new RegExp(issue.pattern, 'g'), issue.url)).toBe(
      'fixes https://git.example.com/acme/shop/-/issues/12 and &#13',
    );
  });
});

describe('parseReviewRefs', () => {
  it('maps commits to merge request numbers and tells which hosting exposes them', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const output = [
      `${a}\trefs/merge-requests/12/head`,
      `${b}\trefs/merge-requests/12/merge`,
      `${a}\trefs/merge-requests/30/head`,
    ].join('\n');

    expect(parseReviewRefs(output)).toEqual({
      byCommit: { [a]: [30, 12] },
      mergeRequests: true,
      pullRequests: false,
    });
  });
});
