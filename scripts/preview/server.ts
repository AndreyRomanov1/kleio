/**
 * Development preview of the Kleio webviews in a regular browser, backed by a real repository.
 * Serves dist/webview.* with a fake VS Code API and answers webview messages over HTTP.
 * The log is at `/`, the commit view at `/commit`, the push and rebase dialogs at `/push` and `/rebase`; they
 * never commit, push or rebase, only record the request (`GET /last-commit`, `/last-push`, `/last-rebase`), so the
 * preview is safe on any repository.
 *
 *   npm run preview -- /path/to/repo [port]
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import * as path from 'node:path';
import type { LogQuery } from '../../src/shared/model';
import type { CommitFile, CommitHostMessage, CommitWebviewMessage } from '../../src/shared/commitProtocol';
import type { HostMessage, WebviewMessage } from '../../src/shared/protocol';
import type { PushHostMessage, PushWebviewMessage } from '../../src/shared/pushProtocol';
import type { RebaseHostMessage, RebaseWebviewMessage } from '../../src/shared/rebaseProtocol';
import type { ConflictsHostMessage, ConflictsWebviewMessage } from '../../src/shared/conflictsProtocol';
import { matchesBranchPattern, readPushState } from '../../src/extension/push/pushState';
import { commitChangeSet, describeRange, rangeChangeSet } from '../../src/extension/changes/changeSet';
import { Repository } from '../../src/extension/git/repository';
import { hunkViews } from '../../src/extension/git/patch';
import { GitLabApi } from '../../src/extension/hosting/gitlabApi';
import { buildCard, buildDiscussions } from '../../src/extension/hosting/mergeRequestCard';
import {
  detectHosting,
  HostingLinks,
  parseRemoteUrl,
  parseReviewRefs,
  type Autolink,
} from '../../src/extension/hosting/hosting';

/**
 * GitLab API for the preview without handling tokens: with KLEIO_PREVIEW_GLAB=1 read-only requests go through the
 * glab CLI, which uses its own login. The extension itself talks to the API directly.
 */
function glabFetch(host: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET') return new Response('read-only preview', { status: 405 });
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v4\//, '') + url.search;
    const { execFile } = await import('node:child_process');
    return new Promise<Response>((resolve) => {
      execFile(
        'glab',
        ['api', '--hostname', host, path],
        { maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          resolve(
            error ? new Response(String(error), { status: 502 }) : new Response(stdout, { status: 200 }),
          );
        },
      );
    });
  }) as typeof fetch;
}

function previewApi(links: HostingLinks | undefined): GitLabApi | undefined {
  if (process.env.KLEIO_PREVIEW_GLAB !== '1' || links?.kind !== 'gitlab') return undefined;
  return new GitLabApi(links.remote.host, links.remote.project, 'via-glab', glabFetch(links.remote.host));
}

let previewLinks: HostingLinks | undefined;
let mergedPage = 0;
const mergedByCommit: Record<string, number[]> = {};
const mergedInfo: Record<
  number,
  { title: string; state: 'opened' | 'closed' | 'locked' | 'merged'; draft: boolean }
> = {};

/** Extra autolink rules for the preview, as JSON in KLEIO_PREVIEW_AUTOLINKS (the extension reads settings). */
const previewAutolinks: Autolink[] = JSON.parse(process.env.KLEIO_PREVIEW_AUTOLINKS ?? '[]') as Autolink[];

/** The remote whose hosting the preview shows, as the `kleio.remote` choice of the extension. */
const previewRemote = process.env.KLEIO_PREVIEW_REMOTE ?? 'origin';

async function hostingMessage(repository: Repository): Promise<HostMessage> {
  const url = (
    await repository.git.run(['remote', 'get-url', previewRemote], { allowExitCodes: [2, 128] })
  ).trim();
  const remote = url ? parseRemoteUrl(url) : undefined;
  const refs = remote
    ? await repository.git
        .run(['ls-remote', previewRemote, 'refs/merge-requests/*/head', 'refs/pull/*/head'], {
          timeoutMs: 15000,
        })
        .catch(() => '')
    : '';
  const reviews = parseReviewRefs(refs);
  const kind = remote ? detectHosting(remote, {}, reviews) : undefined;
  const links = remote && kind ? new HostingLinks(kind, remote) : undefined;
  previewLinks = links;
  const api = previewApi(links);
  const iids = [...new Set(Object.values(reviews.byCommit).flat())];
  const [summaries, pipelines] = api
    ? await Promise.all([api.mergeRequests(iids), api.latestPipelines()]).catch(() => [[], {}] as const)
    : [[], {}];
  const defaultBranch = (
    await repository.git.run(['symbolic-ref', '-q', '--short', `refs/remotes/${previewRemote}/HEAD`], {
      allowExitCodes: [1, 128],
    })
  ).trim();
  return {
    type: 'hosting',
    hosting: {
      name: links?.name,
      kind: links?.kind,
      remote: previewRemote,
      remoteCount: (await repository.git.run(['remote'])).split('\n').filter(Boolean).length,
      mergeRequests: reviews.byCommit,
      defaultBranch: defaultBranch || undefined,
      merged: defaultBranch ? await repository.mergedBranches(defaultBranch) : [],
      autolinks: [...(links?.builtinAutolinks() ?? []), ...previewAutolinks],
      api: api ? 'available' : 'none',
      mergeRequestInfo: Object.fromEntries(summaries.map((s) => [s.iid, s])),
      pipelines,
    },
  };
}

const repoPath = process.argv[2] ?? process.cwd();
const port = Number(process.argv[3] ?? 5173);
const dist = path.resolve(__dirname, '..');
const language = process.env.KLEIO_PREVIEW_LANG ?? 'en';
const translations = (() => {
  try {
    return readFileSync(path.resolve(__dirname, `../../l10n/bundle.l10n.${language}.json`), 'utf8');
  } catch {
    return '{}';
  }
})();
const page = readFileSync(path.resolve(__dirname, '../../scripts/preview/index.html'), 'utf8')
  .replace('<html lang="ru">', `<html lang="${language}">`)
  .replace(
    '<script src="/webview.js"></script>',
    `<script type="application/json" id="l10n">${translations.replace(/</g, '\\u003c')}</script>\n    <script src="/webview.js"></script>`,
  );

let focus: string[] = [];
let query: LogQuery = {};
let favorites: string[] = [];
let changeSetId = 0;
let lastCommit: CommitWebviewMessage | undefined;
let lastPush: PushWebviewMessage | undefined;
let lastRebase: RebaseWebviewMessage | undefined;

/** The conflicts window over the repository as it is; resolving only logs the request. */
async function handleConflicts(
  repository: Repository,
  message: ConflictsWebviewMessage,
): Promise<ConflictsHostMessage[]> {
  if (message.type !== 'ready') {
    console.log('conflicts action (not executed in preview):', JSON.stringify(message));
    return [];
  }
  const [files, state, head] = await Promise.all([
    repository.conflicts(),
    repository.operation(),
    repository.head(),
  ]);
  const short = (hash?: string) => hash?.slice(0, 8) ?? '?';
  return [
    {
      type: 'state',
      operation: state?.kind,
      title: state ? `${state.kind} ${state.branch ?? head.branch ?? ''} на ${short(state.onto)}` : '',
      sides:
        state?.kind === 'rebase'
          ? {
              ours: `${short(state.onto)} (база rebase)`,
              theirs: `${state.branch}: ${short(state.stoppedAt)}`,
            }
          : { ours: head.branch ?? 'HEAD', theirs: short(state?.onto) },
      files,
    },
  ];
}

/** The rebase dialog from KLEIO_PREVIEW_REBASE_FROM (default HEAD~3) to HEAD; starting it only records the plan. */
async function handleRebase(
  repository: Repository,
  message: RebaseWebviewMessage,
): Promise<RebaseHostMessage[]> {
  switch (message.type) {
    case 'ready': {
      const from = await repository.revParse(process.env.KLEIO_PREVIEW_REBASE_FROM ?? 'HEAD~3');
      if (!from) return [{ type: 'error', message: 'нет такого коммита' }];
      const base = (await repository.commitDetails(from)).parents[0];
      const range = await repository.rebaseRange(base);
      const head = await repository.head();
      return [
        {
          type: 'state',
          branch: head.branch ?? 'HEAD',
          base,
          commits: range.commits.map((c) => ({
            hash: c.hash,
            authorName: c.authorName,
            authorDate: c.authorDate,
            message: c.message,
          })),
          initial: range.commits.map((c) => ({ hash: c.hash, action: 'pick', message: c.message })),
          published: await repository.publishedCount(base),
          branches: Object.fromEntries(await repository.stackedBranches(range.commits.map((c) => c.hash))),
        },
      ];
    }
    case 'selectCommit': {
      const details = await repository.commitDetails(message.hash);
      const changeSet = await commitChangeSet(repository, message.hash, details.parents);
      return [{ type: 'files', hash: message.hash, files: changeSet.files }];
    }
    case 'start':
      lastRebase = message;
      console.log('rebase requested (not executed in preview):', JSON.stringify(message));
      return [{ type: 'error', message: 'Превью: rebase не выполняется.' }];
    default:
      return [];
  }
}

async function handlePush(repository: Repository, message: PushWebviewMessage): Promise<PushHostMessage[]> {
  switch (message.type) {
    case 'ready': {
      const state = await readPushState(repository, process.env.KLEIO_PREVIEW_PUSH_BRANCH, (b) =>
        matchesBranchPattern(['master', 'main'], b),
      );
      return [{ type: 'state', remotes: state.remotes, branches: state.branches }];
    }
    case 'selectCommit': {
      const details = await repository.commitDetails(message.hash);
      const changeSet = await commitChangeSet(repository, message.hash, details.parents);
      return [{ type: 'files', hash: message.hash, files: changeSet.files }];
    }
    case 'push':
      lastPush = message;
      console.log('push requested (not executed in preview):', JSON.stringify(message));
      return [{ type: 'error', message: 'Превью: push не выполняется.' }];
    default:
      console.log('ignored in preview:', message.type);
      return [];
  }
}

async function handleCommit(
  repository: Repository,
  message: CommitWebviewMessage,
): Promise<CommitHostMessage[]> {
  switch (message.type) {
    case 'ready':
    case 'refresh': {
      const [changes, stashes, head] = await Promise.all([
        repository.workingChanges(),
        repository.stashes(),
        repository.head(),
      ]);
      const files: CommitFile[] = [
        ...changes.tracked.map((c): CommitFile => ({
          path: c.path,
          oldPath: c.oldPath,
          status: c.status,
          kind: 'tracked',
        })),
        ...changes.untracked.map((p): CommitFile => ({ path: p, status: '?', kind: 'untracked' })),
      ];
      return [
        {
          type: 'state',
          branch: head.branch,
          files,
          stashes,
          staging: false,
          root: repository.root,
          repositories: [{ root: repository.root, name: path.basename(repository.root) }],
        },
      ];
    }
    case 'requestAmendMessage':
      return [{ type: 'amendMessage', message: await repository.lastCommitMessage() }];
    case 'requestHunks':
      return [
        { type: 'hunks', path: message.path, hunks: hunkViews(await repository.workingPatch(message.path)) },
      ];
    case 'requestRecentMessages':
      return [{ type: 'recentMessages', messages: await repository.recentMessages() }];
    case 'commit':
      lastCommit = message;
      console.log('commit requested (not executed in preview):', JSON.stringify(message));
      return [{ type: 'committed' }];
    default:
      console.log('ignored in preview:', message.type);
      return [];
  }
}

async function handle(repository: Repository, message: WebviewMessage): Promise<HostMessage[]> {
  switch (message.type) {
    case 'ready':
    case 'refresh':
    case 'setFocus':
    case 'setQuery':
    case 'toggleFavorite': {
      if (message.type === 'setFocus') focus = message.revisions;
      if (message.type === 'setQuery') query = message.query;
      if (message.type === 'toggleFavorite') {
        favorites = favorites.includes(message.fullName)
          ? favorites.filter((f) => f !== message.fullName)
          : [...favorites, message.fullName];
      }
      const started = Date.now();
      const snapshot = await repository.snapshot({ revisions: focus, query });
      console.log(`snapshot: ${snapshot.commits.length} commits in ${Date.now() - started} ms`);
      return [
        await hostingMessage(repository),
        {
          type: 'snapshot',
          repositories: [{ root: repository.root, name: repository.name }],
          snapshot,
          focus,
          query,
          favorites,
        },
      ];
    }
    case 'selectCommits':
    case 'showStash': {
      const hashes = message.type === 'showStash' ? [message.hash] : message.hashes;
      const commits = await Promise.all(hashes.map((h) => repository.commitDetails(h)));
      const newest = commits[0];
      const oldest = commits[commits.length - 1];
      const changeSet =
        commits.length === 1
          ? await commitChangeSet(repository, newest.hash, newest.parents)
          : await rangeChangeSet(repository, oldest.parents[0], newest.hash, 'Несколько коммитов');
      return [
        {
          type: 'details',
          requestId: message.requestId,
          commits,
          changeSet: {
            id: ++changeSetId,
            title: changeSet.title,
            range: describeRange(changeSet),
            files: changeSet.files,
          },
        },
      ];
    }
    case 'loadMergedMergeRequests': {
      const api = previewApi(previewLinks);
      if (!api) return [{ type: 'mergedMergeRequests', byCommit: {}, info: {}, done: true }];
      const started = Date.now();
      const { items, last } = await api.mergedMergeRequests(++mergedPage);
      for (const item of items) {
        mergedInfo[item.iid] = { title: item.title, state: item.state, draft: item.draft };
        for (const commit of item.commits) (mergedByCommit[commit] ??= []).push(item.iid);
      }
      console.log(`merged page ${mergedPage}: ${items.length} in ${Date.now() - started} ms`);
      return [
        {
          type: 'mergedMergeRequests',
          byCommit: mergedByCommit,
          info: mergedInfo,
          coveredUntil: items[items.length - 1]?.updatedAt,
          done: last,
        },
      ];
    }
    case 'loadMergeRequestCard': {
      const api = previewApi(previewLinks);
      if (!api) return [{ type: 'mergeRequestCard', number: message.number, needsAuth: true }];
      try {
        const [details, approvals] = await Promise.all([
          api.mergeRequest(message.number),
          api.approvals(message.number),
        ]);
        const jobs = details.pipeline ? await api.jobs(details.pipeline.id) : [];
        const bridges = details.pipeline ? await api.bridges(details.pipeline.id).catch(() => []) : [];
        const children: Record<number, Awaited<ReturnType<GitLabApi['jobs']>>> = {};
        for (const bridge of bridges.filter((b) => b.downstream)) {
          children[bridge.downstream!.id] = await api.jobs(
            bridge.downstream!.id,
            bridge.downstream!.projectId,
          );
        }
        return [
          {
            type: 'mergeRequestCard',
            number: message.number,
            card: {
              ...buildCard(details, approvals, jobs, bridges, children),
              discussions: buildDiscussions(
                await api.discussions(message.number).catch(() => []),
                await api.draftNotes(message.number).catch(() => []),
                details.diffRefs?.headSha,
              ),
            },
          },
        ];
      } catch (error) {
        return [{ type: 'mergeRequestCard', number: message.number, error: String(error) }];
      }
    }
    default:
      console.log('ignored in preview:', message.type);
      return [];
  }
}

async function main(): Promise<void> {
  const repository = await Repository.open(repoPath);
  if (!repository) throw new Error(`Not a git repository: ${repoPath}`);

  createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0];
    if (request.method === 'POST' && url === '/commit-message') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        handleCommit(repository, JSON.parse(body) as CommitWebviewMessage)
          .then((messages) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(messages));
          })
          .catch((error: unknown) => {
            console.error(error);
            response.statusCode = 500;
            response.end(String(error));
          });
      });
      return;
    }
    if (request.method === 'POST' && url === '/push-message') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        handlePush(repository, JSON.parse(body) as PushWebviewMessage)
          .then((messages) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(messages));
          })
          .catch((error: unknown) => {
            console.error(error);
            response.statusCode = 500;
            response.end(String(error));
          });
      });
      return;
    }
    if (request.method === 'POST' && url === '/rebase-message') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        handleRebase(repository, JSON.parse(body) as RebaseWebviewMessage)
          .then((messages) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(messages));
          })
          .catch((error: unknown) => {
            console.error(error);
            response.statusCode = 500;
            response.end(String(error));
          });
      });
      return;
    }
    if (request.method === 'POST' && url === '/conflicts-message') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        handleConflicts(repository, JSON.parse(body) as ConflictsWebviewMessage)
          .then((messages) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(messages));
          })
          .catch((error: unknown) => {
            console.error(error);
            response.statusCode = 500;
            response.end(String(error));
          });
      });
      return;
    }
    if (url === '/conflicts') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        page.replace('<body class="vscode-dark">', '<body class="vscode-dark" data-view="conflicts">'),
      );
      return;
    }
    if (url === '/last-rebase') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(lastRebase ?? null));
      return;
    }
    if (url === '/rebase') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        page.replace('<body class="vscode-dark">', '<body class="vscode-dark" data-view="rebase">'),
      );
      return;
    }
    if (url === '/last-push') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(lastPush ?? null));
      return;
    }
    if (url === '/push') {
      response.setHeader('Content-Type', 'text/html');
      response.end(page.replace('<body class="vscode-dark">', '<body class="vscode-dark" data-view="push">'));
      return;
    }
    if (url === '/last-commit') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(lastCommit ?? null));
      return;
    }
    if (url === '/commit') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        page.replace('<body class="vscode-dark">', '<body class="vscode-dark" data-view="commit">'),
      );
      return;
    }
    if (request.method === 'POST' && url === '/message') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        handle(repository, JSON.parse(body) as WebviewMessage)
          .then((messages) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(messages));
          })
          .catch((error: unknown) => {
            console.error(error);
            response.statusCode = 500;
            response.end(String(error));
          });
      });
      return;
    }
    if (url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(page);
      return;
    }
    const types: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.ttf': 'font/ttf',
    };
    const type = types[path.extname(url)];
    try {
      const content = type ? readFileSync(path.join(dist, path.basename(url))) : undefined;
      if (!content) throw new Error('not found');
      response.setHeader('Content-Type', type);
      response.end(content);
    } catch {
      response.statusCode = 404;
      response.end();
    }
  }).listen(port, () => console.log(`Preview of ${repository.root}: http://localhost:${port}`));
}

void main();
