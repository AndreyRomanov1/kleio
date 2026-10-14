import type { Uri } from 'vscode';
import type { FileChange } from '../../shared/model';
import { WORKTREE, type Repository } from '../git/repository';

/** A list of changed files between two revisions; every diff in Grove is shown through one. */
export interface ChangeSet {
  repository: Repository;
  title: string;
  /** Older side; undefined means an empty tree (root commit). */
  left: string | undefined;
  /** Newer side: a revision or {@link WORKTREE}. */
  right: string;
  files: FileChange[];
  /** Precomputed right side per path, so that other features (review comments) attach to the same documents. */
  rightUris?: ReadonlyMap<string, Uri>;
}

export function shortRevision(revision: string | undefined): string {
  if (revision === undefined) return '∅';
  if (revision === WORKTREE) return 'рабочая копия';
  return /^[0-9a-f]{40,64}$/.test(revision) ? revision.slice(0, 8) : revision;
}

export function describeRange(changeSet: Pick<ChangeSet, 'left' | 'right'>): string {
  return `${shortRevision(changeSet.left)} ↔ ${shortRevision(changeSet.right)}`;
}

export async function commitChangeSet(
  repository: Repository,
  hash: string,
  parents: string[],
): Promise<ChangeSet> {
  const left = parents[0];
  return {
    repository,
    title: `Коммит ${hash.slice(0, 8)}`,
    left,
    right: hash,
    files: await repository.changes(left, hash),
  };
}

export async function rangeChangeSet(
  repository: Repository,
  left: string | undefined,
  right: string,
  title: string,
): Promise<ChangeSet> {
  return { repository, title, left, right, files: await repository.changes(left, right) };
}
