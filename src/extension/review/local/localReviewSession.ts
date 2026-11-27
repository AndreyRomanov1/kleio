import type * as vscode from 'vscode';
import { t } from '../../../shared/l10n';
import type { ChangeSet } from '../../changes/changeSet';
import type { Repository } from '../../git/repository';
import { followAnchor, placeIn, versionPlaceOf, type Anchor, type ReviewFile } from '../anchor';
import type { Version } from '../mergeRequest/seenVersions';
import type { Side } from '../positions';
import { documentsOf, reviewFiles } from '../reviewFiles';
import type { ReviewSession } from '../reviewSession';
import type { ShownThread } from '../threadBoard';
import { emptyReview, type LocalReviewStore, type LocalThread } from './localReview';
import { LocalThreads, type LocalPlacement } from './localThreads';

/**
 * What a local review looks at: a branch since it left `target` (new commits make a new version), or a fixed
 * range of commits.
 */
export type LocalTarget =
  { kind: 'branch'; branch: string; target: string } | { kind: 'range'; base: string; head: string };

/** Why a local review could not be taken up; the caller words it. */
export type LocalOpenFailure = 'noBranch' | 'noBase';

/**
 * Threads kept on this machine on a branch or a range of commits. A branch goes on to its new commits: a thread
 * whose lines are the same moves along, one whose lines changed stays outdated in the version it was made on.
 */
export class LocalReviewSession implements ReviewSession {
  readonly outdated = new Map<string, Anchor>();
  readonly interdiffSets: readonly ChangeSet[] = [];
  readonly documents: Map<string, { file: ReviewFile; side: Side }>;

  private readonly versions = new Map<string, Promise<ChangeSet | undefined>>();
  private readonly loadedSets: ChangeSet[] = [];

  private constructor(
    readonly repository: Repository,
    readonly target: LocalTarget,
    readonly version: Version,
    readonly changeSet: ChangeSet,
    private readonly files: ReviewFile[],
    readonly local: LocalThreads,
  ) {
    this.documents = documentsOf(files);
  }

  static async open(
    repository: Repository,
    store: LocalReviewStore,
    target: LocalTarget,
  ): Promise<LocalReviewSession | LocalOpenFailure> {
    const version = await versionOf(repository, target);
    if (typeof version === 'string') return version;
    const { files, rightUris } = await reviewFiles(repository, version.baseSha, version.headSha);
    const key = keyOf(target);
    const title = titleOf(target);
    const review = (await store.load(repository.root, key)) ?? emptyReview(repository.root, key, title);
    review.title = title;
    const author = (await repository.git.run(['config', 'user.name']).catch(() => '')).trim() || t('You');
    const changeSet: ChangeSet = {
      repository,
      title,
      caption: captionOf(target, version),
      reviewKey: `${repository.root}\n${key}`,
      branch: target.kind === 'branch' ? target.branch : undefined,
      left: version.baseSha,
      right: version.headSha,
      files: files.map((f) => f.change),
      rightUris,
    };
    return new LocalReviewSession(
      repository,
      target,
      version,
      changeSet,
      files,
      new LocalThreads(store, review, author),
    );
  }

  /** A branch with new commits or a new base; the review is to go on to them. */
  async moved(): Promise<boolean> {
    const now = await versionOf(this.repository, this.target);
    return typeof now !== 'string' && now.headSha !== this.version.headSha;
  }

  ownSets(): ChangeSet[] {
    return [this.changeSet, ...this.loadedSets];
  }

  versionOf(version: Version): Promise<ChangeSet | undefined> {
    const key = `${version.baseSha}..${version.headSha}`;
    let set = this.versions.get(key);
    if (!set) {
      set = this.workOutVersion(version).catch(() => undefined);
      this.versions.set(key, set);
    }
    return set;
  }

  private async workOutVersion(version: Version): Promise<ChangeSet | undefined> {
    const { repository } = this;
    if (!(await repository.revParse(version.headSha)) || !(await repository.revParse(version.baseSha)))
      return undefined;
    const set: ChangeSet = {
      repository,
      title: t('{0}, version {1}', this.changeSet.title, version.headSha.slice(0, 8)),
      caption: captionOf(this.target, version),
      reviewKey: this.changeSet.reviewKey,
      branch: this.changeSet.branch,
      left: version.baseSha,
      right: version.headSha,
      files: await repository.changes(version.baseSha, version.headSha),
    };
    this.loadedSets.push(set);
    return set;
  }

  async threads(): Promise<ShownThread[]> {
    this.outdated.clear();
    const shown: ShownThread[] = [];
    for (const thread of this.local.all)
      if (thread.anchor) shown.push(this.local.shown(thread, await this.placementOf(thread, thread.anchor)));
    return shown;
  }

  private async placementOf(thread: LocalThread, anchor: Anchor): Promise<LocalPlacement> {
    const current = await this.follow(anchor);
    if (!current) {
      this.outdated.set(`local:${thread.id}`, anchor);
      return { places: [versionPlaceOf(this.repository.root, anchor)], outdated: true };
    }
    if (current !== anchor) await this.local.move(thread.id, current);
    const place = placeIn(this.files, current);
    return { places: place ? [place] : [], outdated: false };
  }

  /** The anchor on the version under review: as it is, or followed there by the diff between the two. */
  private async follow(anchor: Anchor): Promise<Anchor | undefined> {
    const { baseSha, headSha } = this.version;
    if (anchor.baseSha === baseSha && anchor.headSha === headSha) return anchor;
    // Lines of the old side are lines of the base: they stay while the base does.
    if (anchor.side === 'old') return anchor.baseSha === baseSha ? { ...anchor, headSha } : undefined;
    const file = this.files.find((f) => f.change.path === anchor.newPath);
    if (!file) return undefined;
    const range = await followAnchor(this.repository, anchor, headSha, file.change.path);
    if (!range) return undefined;
    return {
      ...anchor,
      baseSha,
      headSha,
      line: range.end.line + 1,
      startLine: anchor.startLine === undefined ? undefined : range.start.line + 1,
    };
  }

  /** Where a comment typed on lines of the diff is kept, and how to name them; undefined outside it. */
  anchorAt(uri: vscode.Uri, range: vscode.Range): Anchor | undefined {
    const placed = this.documents.get(uri.toString());
    if (!placed) return undefined;
    const { file, side } = placed;
    const line = range.end.line + 1;
    const first = range.start.line + 1;
    return {
      ...this.version,
      oldPath: file.change.oldPath ?? file.change.path,
      newPath: file.change.path,
      side,
      line,
      startLine: first < line ? first : undefined,
    };
  }
}

/** The file of a local review: one per branch, whatever its versions, and one per range. */
function keyOf(target: LocalTarget): string {
  return target.kind === 'branch' ? `branch:${target.branch}` : `range:${target.base}..${target.head}`;
}

function titleOf(target: LocalTarget): string {
  return target.kind === 'branch'
    ? t('{0} since {1}', target.branch, target.target)
    : t('Commits {0}…{1}', target.base.slice(0, 8), target.head.slice(0, 8));
}

function captionOf(target: LocalTarget, version: Version): string {
  return target.kind === 'branch'
    ? `${target.branch} @${version.headSha.slice(0, 8)}`
    : `${version.baseSha.slice(0, 8)}..${version.headSha.slice(0, 8)}`;
}

async function versionOf(repository: Repository, target: LocalTarget): Promise<Version | LocalOpenFailure> {
  if (target.kind === 'range') {
    const [baseSha, headSha] = await Promise.all([
      repository.revParse(target.base),
      repository.revParse(target.head),
    ]);
    return baseSha && headSha ? { baseSha, headSha } : 'noBase';
  }
  const headSha = await repository.revParse(target.branch);
  if (!headSha) return 'noBranch';
  const baseSha = await repository.git
    .run(['merge-base', target.target, headSha])
    .then((out) => out.trim())
    .catch(() => '');
  return baseSha ? { baseSha, headSha } : 'noBase';
}
