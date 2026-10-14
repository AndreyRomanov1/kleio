import * as vscode from 'vscode';
import type { Repository } from '../git/repository';
import { detectHosting, HostingLinks, parseRemoteUrl, parseReviewRefs, type Autolink } from './hosting';

const REVIEW_REFS_TTL_MS = 3 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 15_000;

export interface RepositoryHosting {
  remoteName: string;
  /** Undefined when the remote is not a known hosting: then only plain git features work. */
  links?: HostingLinks;
  /** Branch merge requests usually target, e.g. `origin/master`. */
  defaultBranch?: string;
  /** Commit → numbers of merge (pull) requests whose head it is, open or recently merged. */
  mergeRequests: Record<string, number[]>;
}

interface Cached {
  hosting: RepositoryHosting;
  reviewsAt: number;
}

/**
 * Knows where a repository is hosted and which merge requests exist, using only git: the remote URL and the
 * review refs the server exposes (`refs/merge-requests/*` on GitLab, `refs/pull/*` on GitHub).
 */
export class HostingService {
  private readonly cache = new Map<string, Promise<Cached | undefined>>();

  /** Fast answer from what is known; review refs are fetched over the network when stale or `refresh` is set. */
  async hosting(repository: Repository, refresh = false): Promise<RepositoryHosting | undefined> {
    const key = repository.root;
    const cached = await this.cache.get(key);
    if (cached && !refresh && Date.now() - cached.reviewsAt < REVIEW_REFS_TTL_MS) return cached.hosting;
    const next = this.load(repository).catch(() => cached);
    this.cache.set(key, next);
    return (await next)?.hosting;
  }

  /** Without touching the network, e.g. to build links in menus. */
  async known(repository: Repository): Promise<RepositoryHosting | undefined> {
    return (await this.cache.get(repository.root))?.hosting ?? this.hosting(repository);
  }

  autolinks(hosting: RepositoryHosting | undefined): Autolink[] {
    const configured = vscode.workspace.getConfiguration('grove').get<Autolink[]>('autolinks', []);
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
      .getConfiguration('grove')
      .get<Record<string, string>>('hosting.instances', {});
    const kind = remote ? detectHosting(remote, configured, reviews) : undefined;
    return {
      hosting: {
        remoteName,
        links: remote && kind ? new HostingLinks(kind, remote) : undefined,
        defaultBranch,
        mergeRequests: reviews.byCommit,
      },
      reviewsAt: Date.now(),
    };
  }

  private async remoteName(repository: Repository): Promise<string | undefined> {
    const remotes = (await repository.git.run(['remote'])).split('\n').filter(Boolean);
    return remotes.includes('origin') ? 'origin' : remotes[0];
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
