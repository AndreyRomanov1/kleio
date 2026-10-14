import type { Ref } from '../../shared/model';
import type { PushBranchView } from '../../shared/pushProtocol';
import type { Repository } from '../git/repository';

export interface PushState {
  remotes: string[];
  branches: PushBranchView[];
  /** `remote/branch` → commit the remote branch pointed at when the state was read: the lease of a forced push. */
  leases: Map<string, string | undefined>;
}

/**
 * What the push dialog offers: the focused branch (the current one by default) and every other local branch
 * with commits its upstream lacks.
 */
export async function readPushState(
  repository: Repository,
  focusBranch: string | undefined,
  isProtected: (branch: string) => boolean,
): Promise<PushState> {
  const [refs, head, remotesOutput] = await Promise.all([
    repository.refs(),
    repository.head(),
    repository.git.run(['remote']),
  ]);
  const remotes = remotesOutput.split('\n').filter(Boolean);
  const leases = new Map<string, string | undefined>();
  if (remotes.length === 0) return { remotes, branches: [], leases };

  const focus = focusBranch ?? head.branch;
  const byFullName = new Map(refs.map((r) => [r.fullName, r]));
  const candidates = refs.filter(
    (r) => r.kind === 'head' && (r.name === focus || (r.upstream && (r.ahead ?? 0) > 0)),
  );
  candidates.sort((a, b) => Number(b.name === focus) - Number(a.name === focus));

  const branches = await Promise.all(
    candidates.map(async (ref) => {
      const { remote, target, upstream } = destination(ref, byFullName, remotes);
      const remoteRef = byFullName.get(`refs/remotes/${remote}/${target}`);
      leases.set(`${remote}/${target}`, remoteRef?.hash);
      const [commits, counts] = await Promise.all([
        repository.outgoing(ref.name, remoteRef?.fullName),
        remoteRef ? repository.aheadBehind(ref.name, remoteRef.fullName) : undefined,
      ]);
      return {
        branch: ref.name,
        remote,
        target,
        hasUpstream: !!upstream,
        existsOnRemote: !!remoteRef,
        current: ref.name === head.branch,
        behind: counts?.behind ?? 0,
        protected: isProtected(target),
        commits,
        checked: ref.name === focus,
      } satisfies PushBranchView;
    }),
  );
  return { remotes, branches, leases };
}

/** The upstream of the branch, or a branch of the same name on `origin` (or the only remote) for a new one. */
function destination(
  ref: Ref,
  refs: Map<string, Ref>,
  remotes: string[],
): { remote: string; target: string; upstream?: Ref } {
  const upstream = ref.upstream ? refs.get(ref.upstream) : undefined;
  if (upstream) {
    const remote = remotes.find((r) => upstream.name.startsWith(`${r}/`)) ?? upstream.name.split('/')[0];
    return { remote, target: upstream.name.slice(remote.length + 1), upstream };
  }
  return { remote: remotes.includes('origin') ? 'origin' : remotes[0], target: ref.name };
}

/** Arguments of `git push` for one branch; a forced push only overwrites what was seen (`leases`). */
export function pushArgs(
  request: { branch: string; remote: string; target: string; force: boolean },
  setUpstream: boolean,
  lease: string | undefined,
): string[] {
  const args = ['push'];
  if (setUpstream) args.push('--set-upstream');
  if (request.force) args.push(`--force-with-lease=refs/heads/${request.target}:${lease ?? ''}`);
  args.push(request.remote, `refs/heads/${request.branch}:refs/heads/${request.target}`);
  return args;
}

export function matchesBranchPattern(patterns: string[], branch: string): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`).test(branch);
  });
}
