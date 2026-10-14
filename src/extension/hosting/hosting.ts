export type HostingKind = 'gitlab' | 'github';

export interface Remote {
  /** Host name without port, e.g. `git.example.com`. */
  host: string;
  /** Project path without `.git`, e.g. `group/subgroup/project`. */
  project: string;
  /** Web address of the project, e.g. `https://git.example.com/group/project`. */
  webUrl: string;
}

/**
 * Parses the URL of a git remote: scp-like SSH (`git@host:group/project.git`), `ssh://` and `http(s)://`.
 * The web address always uses https, since SSH ports and credentials do not apply to it.
 */
export function parseRemoteUrl(url: string): Remote | undefined {
  const trimmed = url.trim();
  let host: string | undefined;
  let project: string | undefined;

  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp && !/^[a-z]+:\/\//i.test(trimmed)) {
    host = scp[1];
    project = scp[2];
  } else {
    try {
      const parsed = new URL(trimmed);
      if (!['ssh:', 'git+ssh:', 'https:', 'http:', 'git:'].includes(parsed.protocol)) return undefined;
      host = parsed.hostname;
      project = decodeURIComponent(parsed.pathname);
    } catch {
      return undefined;
    }
  }

  project = project
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  if (!host || !project.includes('/')) return undefined;
  return { host, project, webUrl: `https://${host}/${project}` };
}

const KNOWN_HOSTS: Record<string, HostingKind> = { 'github.com': 'github', 'gitlab.com': 'gitlab' };

/** Hosting of a remote: from user settings, well-known hosts, or the review refs the server exposes. */
export function detectHosting(
  remote: Remote,
  configured: Record<string, string>,
  refs: { mergeRequests: boolean; pullRequests: boolean },
): HostingKind | undefined {
  const fromSettings = configured[remote.host];
  if (fromSettings === 'gitlab' || fromSettings === 'github') return fromSettings;
  if (KNOWN_HOSTS[remote.host]) return KNOWN_HOSTS[remote.host];
  if (refs.mergeRequests) return 'gitlab';
  if (refs.pullRequests) return 'github';
  return undefined;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Web links of a project; GitLab and GitHub differ only in path shapes. */
export class HostingLinks {
  constructor(
    readonly kind: HostingKind,
    readonly remote: Remote,
  ) {}

  get name(): string {
    return this.kind === 'gitlab' ? 'GitLab' : 'GitHub';
  }

  private get base(): string {
    return this.kind === 'gitlab' ? `${this.remote.webUrl}/-` : this.remote.webUrl;
  }

  commit(hash: string): string {
    return `${this.base}/commit/${hash}`;
  }

  branch(name: string): string {
    return `${this.base}/tree/${encodePath(name)}`;
  }

  /** `lines` are 1-based and inclusive. */
  file(revision: string, path: string, lines?: { start: number; end: number }): string {
    const url = `${this.base}/blob/${encodePath(revision)}/${encodePath(path)}`;
    if (!lines) return url;
    if (lines.start === lines.end) return `${url}#L${lines.start}`;
    return this.kind === 'gitlab'
      ? `${url}#L${lines.start}-${lines.end}`
      : `${url}#L${lines.start}-L${lines.end}`;
  }

  mergeRequest(number: number): string {
    return this.kind === 'gitlab' ? `${this.base}/merge_requests/${number}` : `${this.base}/pull/${number}`;
  }

  issue(number: number): string {
    return `${this.base}/issues/${number}`;
  }

  newMergeRequest(source: string, target: string): string {
    if (this.kind === 'github')
      return `${this.base}/compare/${encodePath(target)}...${encodePath(source)}?expand=1`;
    const query = new URLSearchParams({
      'merge_request[source_branch]': source,
      'merge_request[target_branch]': target,
    });
    return `${this.base}/merge_requests/new?${query}`;
  }

  /** Autolinks every hosting understands in commit messages: `!12` for GitLab merge requests, `#12` for issues. */
  builtinAutolinks(): Autolink[] {
    const issues: Autolink = { pattern: '(?<![\\w&])#(\\d+)\\b', url: `${this.base}/issues/$1` };
    if (this.kind === 'github') return [issues];
    return [{ pattern: '(?<![\\w&])!(\\d+)\\b', url: `${this.base}/merge_requests/$1` }, issues];
  }
}

/** A rule turning text in commit messages into links: a regular expression and a URL with `$0`, `$1`… */
export interface Autolink {
  pattern: string;
  url: string;
}

/** Parses `git ls-remote` output of review refs into commit → numbers of merge (pull) requests at it. */
export function parseReviewRefs(output: string): {
  byCommit: Record<string, number[]>;
  mergeRequests: boolean;
  pullRequests: boolean;
} {
  const byCommit: Record<string, number[]> = {};
  let mergeRequests = false;
  let pullRequests = false;
  for (const line of output.split('\n')) {
    const match = /^([0-9a-f]{40,64})\trefs\/(merge-requests|pull)\/(\d+)\/head$/.exec(line.trim());
    if (!match) continue;
    if (match[2] === 'merge-requests') mergeRequests = true;
    else pullRequests = true;
    (byCommit[match[1]] ??= []).push(Number(match[3]));
  }
  for (const numbers of Object.values(byCommit)) numbers.sort((a, b) => b - a);
  return { byCommit, mergeRequests, pullRequests };
}
