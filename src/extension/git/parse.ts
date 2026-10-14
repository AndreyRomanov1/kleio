import type { ChangeStatus, Commit, FileChange, Ref, Stash, Worktree } from '../../shared/model';

export const FIELD = '\x1f';
export const RECORD = '\x1e';

export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f') + '%x1e';

export function parseLog(output: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\n/, '');
    if (!trimmed) continue;
    const [hash, parents, authorName, authorEmail, authorDate, subject] = trimmed.split(FIELD);
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      authorName,
      authorEmail,
      authorDate: Number(authorDate),
      subject: subject ?? '',
    });
  }
  return commits;
}

export const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(upstream)',
  '%(upstream:track,nobracket)',
].join('%1f');

export function parseRefs(output: string): Ref[] {
  const refs: Ref[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [fullName, objectName, peeled, upstream, track] = line.split(FIELD);
    const ref = toRef(fullName, peeled || objectName);
    if (!ref) continue;
    if (ref.kind === 'head' && upstream) {
      ref.upstream = upstream;
      Object.assign(ref, parseTrack(track ?? ''));
    }
    refs.push(ref);
  }
  return refs;
}

function toRef(fullName: string, hash: string): Ref | undefined {
  if (fullName.startsWith('refs/heads/')) {
    return { fullName, hash, kind: 'head', name: fullName.slice('refs/heads/'.length) };
  }
  if (fullName.startsWith('refs/remotes/')) {
    const name = fullName.slice('refs/remotes/'.length);
    if (name.endsWith('/HEAD')) return undefined;
    return { fullName, hash, kind: 'remote', name };
  }
  if (fullName.startsWith('refs/tags/')) {
    return { fullName, hash, kind: 'tag', name: fullName.slice('refs/tags/'.length) };
  }
  return undefined;
}

function parseTrack(track: string): Pick<Ref, 'ahead' | 'behind' | 'upstreamGone'> {
  if (track === 'gone') return { upstreamGone: true };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

export function parseWorktrees(output: string, currentRoot: string): Worktree[] {
  const worktrees: Worktree[] = [];
  for (const block of output.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length === 0) continue;
    const worktree: Worktree = {
      path: '',
      isMain: worktrees.length === 0,
      isCurrent: false,
      locked: false,
      prunable: false,
    };
    for (const line of lines) {
      const space = line.indexOf(' ');
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? '' : line.slice(space + 1);
      switch (key) {
        case 'worktree':
          worktree.path = value;
          break;
        case 'HEAD':
          worktree.head = value;
          break;
        case 'branch':
          worktree.branch = value.replace(/^refs\/heads\//, '');
          break;
        case 'locked':
          worktree.locked = true;
          break;
        case 'prunable':
          worktree.prunable = true;
          break;
      }
    }
    if (worktree.head === '0000000000000000000000000000000000000000') worktree.head = undefined;
    worktree.isCurrent = samePath(worktree.path, currentRoot);
    worktrees.push(worktree);
  }
  return worktrees;
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

export const STASH_FORMAT = ['%H', '%P', '%gd', '%at', '%gs'].join('%x1f') + '%x1e';

export function parseStashes(output: string): Stash[] {
  const stashes: Stash[] = [];
  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\n/, '');
    if (!trimmed) continue;
    const [hash, parents, selector, date, message] = trimmed.split(FIELD);
    stashes.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      selector,
      date: Number(date),
      message: message ?? '',
    });
  }
  return stashes;
}

/** Parses `--name-status -z` output of `git diff` / `git diff-tree`. */
export function parseNameStatus(output: string): FileChange[] {
  const parts = output.split('\0');
  const changes: FileChange[] = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i++];
    if (!code) continue;
    const status = code[0] as ChangeStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i++];
      const path = parts[i++];
      changes.push({ status, path, oldPath });
    } else {
      changes.push({ status, path: parts[i++] });
    }
  }
  return changes;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** Extracts hunk headers from unified diff output (`git diff -U0`). */
export function parseHunks(output: string): Hunk[] {
  const hunks: Hunk[] = [];
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (let match = header.exec(output); match; match = header.exec(output)) {
    hunks.push({
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}
