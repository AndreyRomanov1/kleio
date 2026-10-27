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
 * with commits its upstream lacks. Branches of the focused one's stack that a rebase rewrote — the branches it
 * was made on top of, diverged from the server — are checked along with it, as they go to the server together.
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
      const { view, lease } = await describeBranch(repository, ref, remote, target, byFullName, isProtected, {
        focus,
        current: head.branch,
        upstream: upstream?.name,
      });
      leases.set(`${remote}/${target}`, lease);
      return view;
    }),
  );
  return { remotes, branches, leases };
}

/**
 * What a push of a local branch to `remote/target` sends, any remote and name, as Rider's push dialog lets
 * them change: the commits missing there and whether the server has some missing here. A push elsewhere than
 * the upstream does not change the upstream, as `git push <remote> <branch>` does not.
 */
export async function retarget(
  repository: Repository,
  branch: string,
  remote: string,
  target: string,
  isProtected: (branch: string) => boolean,
  focus: string | undefined,
): Promise<{ view: PushBranchView; lease: string | undefined } | undefined> {
  const [refs, head] = await Promise.all([repository.refs(), repository.head()]);
  const ref = refs.find((r) => r.kind === 'head' && r.name === branch);
  if (!ref) return undefined;
  const byFullName = new Map(refs.map((r) => [r.fullName, r]));
  const upstream = ref.upstream ? byFullName.get(ref.upstream)?.name : undefined;
  return describeBranch(repository, ref, remote, target, byFullName, isProtected, {
    focus,
    current: head.branch,
    upstream,
  });
}

async function describeBranch(
  repository: Repository,
  ref: Ref,
  remote: string,
  target: string,
  byFullName: Map<string, Ref>,
  isProtected: (branch: string) => boolean,
  context: { focus?: string; current?: string; upstream?: string },
): Promise<{ view: PushBranchView; lease: string | undefined }> {
  const { focus } = context;
  const remoteRef = byFullName.get(`refs/remotes/${remote}/${target}`);
  const [commits, counts, stacked] = await Promise.all([
    repository.outgoing(ref.name, remoteRef?.fullName),
    remoteRef ? repository.aheadBehind(ref.name, remoteRef.fullName) : undefined,
    focus && ref.name !== focus ? repository.isAncestor(ref.name, focus) : false,
  ]);
  const view: PushBranchView = {
    branch: ref.name,
    remote,
    target,
    hasUpstream: !!context.upstream,
    upstream: context.upstream,
    existsOnRemote: !!remoteRef,
    current: ref.name === context.current,
    behind: counts?.behind ?? 0,
    protected: isProtected(target),
    commits,
    checked: ref.name === focus || (stacked && (counts?.behind ?? 0) > 0 && !isProtected(target)),
  };
  return { view, lease: remoteRef?.hash };
}

/** The upstream of the branch, or a branch of the same name on `origin` (or the only remote) for a new one. */
function destination(
  ref: Ref,
  refs: Map<string, Ref>,
  remotes: string[],
): { remote: string; target: string; upstream?: Ref } {
  const tracked = ref.upstream ? refs.get(ref.upstream) : undefined;
  // An upstream that is a local branch is no place to push to.
  const upstream = tracked?.kind === 'remote' ? tracked : undefined;
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
