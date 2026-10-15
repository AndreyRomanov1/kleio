import * as vscode from 'vscode';
import type { Repository } from '../git/repository';
import {
  createGitLabApi,
  GitLabApiError,
  type GitLabApi,
  type MergedMergeRequest,
  type MergeRequestSummary,
  type PipelineStatus,
} from './gitlabApi';
import type { GitLabAuth } from './gitlabAuth';
import { GitHubApi, GitHubApiError } from './githubApi';
import type { GitHubAuth } from './githubAuth';
import { detectHosting, HostingLinks, parseRemoteUrl, parseReviewRefs, type Autolink } from './hosting';

/** Whether the hosting API can be used: not applicable, working, or waiting for the user to give access. */
export type ApiState = 'none' | 'available' | 'needsAuth';

const REVIEW_REFS_TTL_MS = 3 * 60 * 1000;
const REMOTE_KEY = 'kleio.remote';
const NETWORK_TIMEOUT_MS = 15_000;

export interface RepositoryHosting {
  remoteName: string;
  /** How many remotes the repository has: with more than one, the hosting remote can be chosen. */
  remoteCount: number;
  /** Undefined when the remote is not a known hosting: then only plain git features work. */
  links?: HostingLinks;
  /** Branch merge requests usually target, e.g. `origin/master`. */
  defaultBranch?: string;
  /** Commit → numbers of merge (pull) requests whose head it is, open or recently merged. */
  mergeRequests: Record<string, number[]>;
  api: ApiState;
  /** Title and state of the merge requests above, when the API is available. */
  mergeRequestInfo: Record<number, MergeRequestSummary>;
  /** Commit → status of its latest pipeline, among the project's recent pipelines. */
  pipelines: Record<string, PipelineStatus>;
}

/** Merged merge requests loaded so far, going back in time page by page as the log is scrolled down. */
export interface MergedHistory {
  byCommit: Record<string, number[]>;
  info: Record<number, MergeRequestSummary>;
  /** Everything merged after this moment (unix seconds) is loaded. */
  coveredUntil?: number;
  done: boolean;
}

interface MergedState extends MergedHistory {
  nextPage: number;
  /** Where the next page of GitHub starts. */
  cursor?: string;
  loading?: Promise<void>;
}

/** Commits whose checks are asked for on GitHub: heads of branches and pull requests, newest first. */
const CHECKED_COMMITS = 200;

/** Pages per request of the log: enough to cover a long scroll, bounded so a jump to the root stays cheap. */
const MERGED_PAGES_PER_REQUEST = 5;

interface Cached {
  hosting: RepositoryHosting;
  reviewsAt: number;
}

/**
 * Knows where a repository is hosted and which merge requests exist, using only git: the remote URL and the
 * review refs the server exposes (`refs/merge-requests/*` on GitLab, `refs/pull/*` on GitHub).
 */
export class HostingService implements vscode.Disposable {
  private readonly cache = new Map<string, Promise<Cached | undefined>>();
  private readonly merged = new Map<string, MergedState>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;

  /** Fires when access to the hosting API changes: views reload their hosting details. */
  readonly onDidChange = this.changed.event;

  constructor(
    readonly auth: GitLabAuth,
    readonly githubAuth: GitHubAuth,
  ) {
    const reset = () => {
      this.cache.clear();
      this.merged.clear();
      this.changed.fire();
    };
    this.subscription = vscode.Disposable.from(auth.onDidChange(reset), githubAuth.onDidChange(reset));
  }

  /** API client for the repository's GitHub project. */
  async github(repository: Repository, interactive = false): Promise<GitHubApi | undefined> {
    const links = (await this.known(repository))?.links;
    if (!links || links.kind !== 'github') return undefined;
    const token = await this.githubAuth.token(links.remote.host, interactive);
    return token ? new GitHubApi(links.remote.host, links.remote.project, token) : undefined;
  }

  /** Asks for access to the repository's hosting; true when it was given. */
  async connect(repository: Repository): Promise<boolean> {
    const links = (await this.known(repository))?.links;
    if (!links) return false;
    return links.kind === 'gitlab'
      ? this.auth.connect(links.remote.host)
      : this.githubAuth.connect(links.remote.host);
  }

  /** API client for the repository's GitLab project; `interactive` may ask the user for access. */
  async gitlab(repository: Repository, interactive = false): Promise<GitLabApi | undefined> {
    const hosting = await this.known(repository);
    const links = hosting?.links;
    if (!links || links.kind !== 'gitlab') return undefined;
    const source = await this.auth.token(links.remote.host, interactive);
    return source ? createGitLabApi(links.remote.host, links.remote.project, source.token) : undefined;
  }

  /**
   * Fast answer from what is known; review refs are fetched over the network when stale or `refresh` is set.
   * With background refresh turned off, only the first load and an explicit refresh go to the network.
   */
  async hosting(repository: Repository, refresh = false): Promise<RepositoryHosting | undefined> {
    const key = repository.root;
    const cached = await this.cache.get(key);
    const background = vscode.workspace
      .getConfiguration('kleio')
      .get<boolean>('hosting.backgroundRefresh', true);
    if (cached && !refresh && (!background || Date.now() - cached.reviewsAt < REVIEW_REFS_TTL_MS))
      return cached.hosting;
    const next = this.load(repository).catch(() => cached);
    this.cache.set(key, next);
    return (await next)?.hosting;
  }

  /** Without touching the network, e.g. to build links in menus. */
  async known(repository: Repository): Promise<RepositoryHosting | undefined> {
    return (await this.cache.get(repository.root))?.hosting ?? this.hosting(repository);
  }

  /**
   * Loads merged merge requests until those merged after `before` (unix seconds) are all known, a few pages at
   * a time; their refs on the server are gone some time after the merge, the API still has them.
   */
  async mergedBefore(repository: Repository, before: number): Promise<MergedHistory | undefined> {
    const key = repository.root;
    let state = this.merged.get(key);
    if (!state) this.merged.set(key, (state = { byCommit: {}, info: {}, done: false, nextPage: 1 }));
    const current = state;
    while (current.loading) await current.loading;
    if (current.done || (current.coveredUntil !== undefined && current.coveredUntil < before)) return current;
    const [gitlab, github] = await Promise.all([this.gitlab(repository), this.github(repository)]);
    if (!gitlab && !github) return undefined;
    const page = async (): Promise<{ items: MergedMergeRequest[]; last: boolean }> => {
      if (gitlab) return gitlab.mergedMergeRequests(current.nextPage++);
      const { items, next } = await github!.mergedPullRequests(current.cursor);
      current.cursor = next;
      return { items, last: !next };
    };
    current.loading = (async () => {
      for (let i = 0; i < MERGED_PAGES_PER_REQUEST; i++) {
        const { items, last } = await page();
        for (const item of items) {
          current.info[item.iid] = {
            iid: item.iid,
            title: item.title,
            state: item.state,
            draft: item.draft,
            webUrl: item.webUrl,
          };
          for (const commit of item.commits) {
            const list = (current.byCommit[commit] ??= []);
            if (!list.includes(item.iid)) list.push(item.iid);
          }
        }
        const oldest = items[items.length - 1]?.updatedAt;
        if (oldest !== undefined) current.coveredUntil = oldest;
        if (last) current.done = true;
        if (current.done || (current.coveredUntil !== undefined && current.coveredUntil < before)) break;
      }
    })().finally(() => (current.loading = undefined));
    await current.loading;
    return current;
  }

  autolinks(hosting: RepositoryHosting | undefined): Autolink[] {
    const configured = vscode.workspace.getConfiguration('kleio').get<Autolink[]>('autolinks', []);
    const valid = configured.filter((l) => typeof l?.pattern === 'string' && typeof l?.url === 'string');
    return [...(hosting?.links?.builtinAutolinks() ?? []), ...valid];
  }

  private async load(repository: Repository): Promise<Cached | undefined> {
    const remoteName = await this.remoteName(repository);
    if (!remoteName) return undefined;
    const url = (await repository.git.run(['remote', 'get-url', remoteName])).trim();
    const remote = parseRemoteUrl(url);
    const [refsOutput, defaultBranch] = await Promise.all([
      remote
        ? repository.git
            .run(['ls-remote', remoteName, 'refs/merge-requests/*/head', 'refs/pull/*/head'], {
              timeoutMs: NETWORK_TIMEOUT_MS,
            })
            .catch(() => '')
        : Promise.resolve(''),
      this.defaultBranch(repository, remoteName),
    ]);
    const reviews = parseReviewRefs(refsOutput);
    const configured = vscode.workspace
      .getConfiguration('kleio')
      .get<Record<string, string>>('hosting.instances', {});
    const kind = remote ? detectHosting(remote, configured, reviews) : undefined;
    const links = remote && kind ? new HostingLinks(kind, remote) : undefined;
    const hosting: RepositoryHosting = {
      remoteName,
      remoteCount: (await this.remotes(repository)).length,
      links,
      defaultBranch,
      mergeRequests: reviews.byCommit,
      api: 'none',
      mergeRequestInfo: {},
      pipelines: {},
    };
    if (links?.kind === 'gitlab') await this.loadApiDetails(hosting, links);
    if (links?.kind === 'github') await this.loadGitHubDetails(repository, hosting, links);
    return { hosting, reviewsAt: Date.now() };
  }

  /** Pull request states and the checks of branch heads, in a request or two, only with access already given. */
  private async loadGitHubDetails(
    repository: Repository,
    hosting: RepositoryHosting,
    links: HostingLinks,
  ): Promise<void> {
    const token = await this.githubAuth.token(links.remote.host);
    if (!token) {
      hosting.api = 'needsAuth';
      return;
    }
    const api = new GitHubApi(links.remote.host, links.remote.project, token);
    const numbers = [...new Set(Object.values(hosting.mergeRequests).flat())];
    const refs = await repository.refs();
    const heads = [
      ...new Set([
        ...Object.keys(hosting.mergeRequests),
        ...refs.filter((r) => r.kind !== 'tag').map((r) => r.hash),
      ]),
    ];
    try {
      const [summaries, checks] = await Promise.all([
        api.pullRequests(numbers),
        api.checks(heads.slice(0, CHECKED_COMMITS)),
      ]);
      hosting.api = 'available';
      hosting.pipelines = checks;
      for (const summary of summaries) hosting.mergeRequestInfo[summary.iid] = summary;
    } catch (error) {
      hosting.api = error instanceof GitHubApiError && error.unauthorized ? 'needsAuth' : 'none';
    }
  }

  /** Merge request states and pipeline statuses in two requests, only with access already given. */
  private async loadApiDetails(hosting: RepositoryHosting, links: HostingLinks): Promise<void> {
    const source = await this.auth.token(links.remote.host);
    if (!source) {
      hosting.api = 'needsAuth';
      return;
    }
    const api = createGitLabApi(links.remote.host, links.remote.project, source.token);
    const iids = [...new Set(Object.values(hosting.mergeRequests).flat())];
    try {
      const [summaries, pipelines] = await Promise.all([api.mergeRequests(iids), api.latestPipelines()]);
      hosting.api = 'available';
      hosting.pipelines = pipelines;
      for (const summary of summaries) hosting.mergeRequestInfo[summary.iid] = summary;
    } catch (error) {
      hosting.api = error instanceof GitLabApiError && error.unauthorized ? 'needsAuth' : 'none';
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  /** The remote chosen with {@link setRemote}, otherwise `origin`, otherwise the first one. */
  private async remoteName(repository: Repository): Promise<string | undefined> {
    const remotes = await this.remotes(repository);
    const chosen = (
      await repository.git.run(['config', '--get', REMOTE_KEY], { allowExitCodes: [1] })
    ).trim();
    if (chosen && remotes.includes(chosen)) return chosen;
    return remotes.includes('origin') ? 'origin' : remotes[0];
  }

  async remotes(repository: Repository): Promise<string[]> {
    return (await repository.git.run(['remote'])).split('\n').filter(Boolean);
  }

  /**
   * Makes the hosting of another remote the one Kleio shows, e.g. GitHub for a repository whose `origin` is a
   * GitLab mirror. Kept in the repository's own config, as `gh` keeps its choice of a remote.
   */
  async setRemote(repository: Repository, remote: string): Promise<void> {
    await repository.git.run(['config', REMOTE_KEY, remote]);
    this.cache.delete(repository.root);
    this.merged.delete(repository.root);
    this.changed.fire();
  }

  private async defaultBranch(repository: Repository, remote: string): Promise<string | undefined> {
    const head = await repository.git.run(['symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`], {
      allowExitCodes: [1, 128],
    });
    if (head.trim()) return head.trim();
    for (const name of ['main', 'master']) {
      if (await repository.revParse(`refs/remotes/${remote}/${name}`)) return `${remote}/${name}`;
    }
    return undefined;
  }
}
