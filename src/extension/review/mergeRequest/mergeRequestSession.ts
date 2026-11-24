import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { FileChange } from '../../../shared/model';
import { t } from '../../../shared/l10n';
import type { ChangeSet } from '../../changes/changeSet';
import { revisionUri, workingFileUri } from '../../content/revisionUri';
import type { Hunk } from '../../git/parse';
import type { Repository } from '../../git/repository';
import type { DiffPosition, DiffRefs, Discussion, DraftNote, GitLabApi } from '../../hosting/gitlabApi';
import {
  anchorOf,
  followAnchor,
  placeIn,
  samePlace,
  versionPlaceOf,
  type Anchor,
  type Place,
  type ReviewFile,
} from '../anchor';
import { lineCounters, linePair, type Side } from '../positions';
import type { ShownNote, ShownThread } from '../threadBoard';
import type { SeenVersions, Version } from './seenVersions';

/**
 * What changed from one version of a merge request to another, as GitLab compares versions: after a rebase the
 * earlier changes are first moved onto the new base, so that what came from the target branch is not shown
 * as the author's work.
 */
export interface Interdiff {
  set: ChangeSet;
  from: Version;
  left: string;
  files: FileChange[];
  /** The earlier version did not move onto the new base, and the diff has the changes of the rebase. */
  conflicted: boolean;
}

/** The newer version the review was offered while it stayed on this one. */
export type NewerVersion = Version & { number?: number; createdAt?: string };

/** Why a merge request could not be taken up for a review; the caller words it. */
export type OpenFailure = 'noAccess' | 'noVersions' | 'noCommits';

/**
 * A GitLab merge request under review at one of its versions: its diff, the diffs of its other versions, and
 * where its discussions stand in them.
 */
export class MergeRequestSession {
  /** Taken up by itself as the merge request of the current branch, not opened by hand. */
  auto = false;
  /** The version looked at last before this one, to show what changed since then. */
  previous?: Version;
  /** The merge request has a version you have not looked at yet. */
  changed: boolean;
  /** A newer version pushed while the diff of this one is open: the review stays on this one until you choose. */
  newer?: NewerVersion;
  /** The newer version you chose to finish this one before going to. */
  dismissed?: string;
  /** Your drafts, to offer sending them as GitLab's "Submit review". */
  drafts = 0;
  /** Comments of the newer version on lines this one has not. */
  newerOnly = 0;
  /** Outdated discussions by id: where they were made. */
  readonly outdated = new Map<string, Anchor>();
  /** Document URI → file and side, for placing comments. */
  readonly documents = new Map<string, { file: ReviewFile; side: Side }>();

  /** Diffs of earlier versions by `base..head`, for its outdated discussions. */
  private readonly versions = new Map<string, Promise<ChangeSet | undefined>>();
  /** Diffs between two versions by `from..to`, each worked out once. */
  private readonly interdiffs = new Map<string, Promise<Interdiff | undefined>>();
  private readonly loadedInterdiffs: Interdiff[] = [];
  /** The diffs worked out for the review besides the merge request: since the last review, earlier versions. */
  private readonly loadedSets: ChangeSet[] = [];
  private readonly hunks = new Map<ReviewFile, Promise<Hunk[]>>();

  private constructor(
    readonly repository: Repository,
    readonly api: GitLabApi,
    private readonly remote: string,
    /** Username of the reviewer, to tell their own comments. */
    private readonly me: string | undefined,
    readonly iid: number,
    /** `host/project!iid`, for the journal and the versions looked at. */
    readonly label: string,
    readonly refs: DiffRefs,
    readonly changeSet: ChangeSet,
    readonly files: ReviewFile[],
    /** Version numbers by head, as GitLab counts them: one for each push, from 1. */
    public numbers: Map<string, number>,
    seen: SeenVersions,
  ) {
    for (const file of files) {
      if (file.left) this.documents.set(file.left.toString(), { file, side: 'old' });
      if (file.right) this.documents.set(file.right.toString(), { file, side: 'new' });
    }
    const { previous, changed } = seen.before(label, refs.headSha);
    this.previous = previous;
    this.changed = changed;
  }

  /** Takes the merge request up at its latest version; fetches its commits when they are missing. */
  static async open(
    api: GitLabApi,
    repository: Repository,
    remote: string,
    iid: number,
    label: string,
    seen: SeenVersions,
  ): Promise<MergeRequestSession | Exclude<OpenFailure, 'noAccess'>> {
    const details = await api.mergeRequest(iid);
    const refs = details.diffRefs;
    if (!refs) return 'noVersions';
    if (!(await ensureCommits(repository, remote, iid, details.targetBranch, refs))) return 'noCommits';

    const changes = await repository.changes(refs.baseSha, refs.headSha);
    // One call tells which files on disk are the same as in the merge request: those open as real files.
    const differing = new Set(
      (await repository.git.run(['diff', '--name-only', '-z', refs.headSha, '--']))
        .split('\0')
        .filter(Boolean),
    );
    const files: ReviewFile[] = changes.map((change) => {
      const onDisk = !differing.has(change.path) && existsSync(path.join(repository.root, change.path));
      return {
        change,
        left:
          change.status === 'A'
            ? undefined
            : revisionUri(repository.root, refs.baseSha, change.oldPath ?? change.path),
        right:
          change.status === 'D'
            ? undefined
            : onDisk
              ? workingFileUri(repository.root, change.path)
              : revisionUri(repository.root, refs.headSha, change.path),
      };
    });
    const rightUris = new Map(files.filter((f) => f.right).map((f) => [f.change.path, f.right!] as const));
    const numbers = await versionNumbers(api, iid);
    const number = numbers.get(refs.headSha);
    const me = await api
      .currentUser()
      .then((p) => p.username)
      .catch(() => undefined);
    const changeSet: ChangeSet = {
      repository,
      title: `MR !${iid}`,
      caption: number ? `MR !${iid} v${number}` : undefined,
      reviewKey: label,
      left: refs.baseSha,
      right: refs.headSha,
      files: changes,
      rightUris,
    };
    return new MergeRequestSession(
      repository,
      api,
      remote,
      me,
      iid,
      label,
      refs,
      changeSet,
      files,
      numbers,
      seen,
    );
  }

  /** The version under review. */
  get current(): Version {
    return { baseSha: this.refs.baseSha, headSha: this.refs.headSha };
  }

  /** A version pushed after the one under review. */
  isNewer(head: string): boolean {
    const number = this.numbers.get(head);
    const own = this.numbers.get(this.refs.headSha);
    return number !== undefined && own !== undefined && number > own;
  }

  /** `v3` when GitLab's number of the version is known, else its short head. */
  versionName(version: Version): string {
    const number = this.numbers.get(version.headSha);
    return number ? `v${number}` : version.headSha.slice(0, 8);
  }

  async refreshNumbers(): Promise<void> {
    this.numbers = await versionNumbers(this.api, this.iid, this.numbers);
  }

  /** The diffs of the review: the merge request, what changed since the last review, its earlier versions. */
  ownSets(): ChangeSet[] {
    return [this.changeSet, ...this.loadedSets];
  }

  /** The comparisons between versions worked out so far. */
  get interdiffSets(): ChangeSet[] {
    return this.loadedInterdiffs.map((i) => i.set);
  }

  /** What changed since the version looked at last time. */
  since(): Promise<Interdiff | undefined> | undefined {
    return this.previous && this.interdiffOf(this.previous, this.current);
  }

  interdiffOf(from: Version, to: Version): Promise<Interdiff | undefined> {
    const key = `${from.headSha}..${to.headSha}`;
    let interdiff = this.interdiffs.get(key);
    if (!interdiff) {
      interdiff = this.workOutInterdiff(from, to).catch(() => undefined);
      this.interdiffs.set(key, interdiff);
    }
    return interdiff;
  }

  private async workOutInterdiff(from: Version, to: Version): Promise<Interdiff | undefined> {
    const { repository } = this;
    if (!(await this.ensureVersionCommits([from.baseSha, from.headSha, to.baseSha, to.headSha])))
      return undefined;
    let left = from.headSha;
    let conflicted = false;
    if (!(await repository.isAncestor(from.headSha, to.headSha))) {
      const tree = await repository.rebasedTree(from.baseSha, from.headSha, to.baseSha);
      if (tree) left = tree;
      else conflicted = true;
    }
    const files = await repository.changes(left, to.headSha);
    const latest = to.headSha === this.refs.headSha;
    const set: ChangeSet = {
      repository,
      title:
        latest && from.headSha === this.previous?.headSha
          ? t('!{0} since the last review', this.iid)
          : t('!{0}: {1} → {2}', this.iid, this.versionName(from), this.versionName(to)),
      caption: `!${this.iid} ${this.versionName(from)} → ${this.versionName(to)}`,
      reviewKey: this.label,
      left,
      right: to.headSha,
      files,
      rightUris: latest ? this.changeSet.rightUris : undefined,
    };
    const interdiff = { set, from, left, files, conflicted };
    this.loadedSets.push(set);
    this.loadedInterdiffs.push(interdiff);
    return interdiff;
  }

  /** Commits of earlier versions may be gone from the branch after a force push; GitLab keeps them. */
  async ensureVersionCommits(shas: string[]): Promise<boolean> {
    const { repository } = this;
    const missing = async () =>
      (await Promise.all(shas.map((sha) => repository.revParse(sha)))).some((s) => !s);
    if (!(await missing())) return true;
    await repository.git
      .run(['fetch', this.remote, ...new Set(shas)], { timeoutMs: 120_000 })
      .catch(() => undefined);
    return !(await missing());
  }

  /**
   * The diff of a version of the merge request, as GitLab showed it then: outdated discussions are in it at
   * the lines they were made on.
   */
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
    if (!(await this.ensureVersionCommits([version.baseSha, version.headSha]))) return undefined;
    const set: ChangeSet = {
      repository,
      title: t('!{0}, version {1}', this.iid, version.headSha.slice(0, 8)),
      caption: `!${this.iid} ${this.versionName(version)}`,
      reviewKey: this.label,
      left: version.baseSha,
      right: version.headSha,
      files: await repository.changes(version.baseSha, version.headSha),
    };
    this.loadedSets.push(set);
    return set;
  }

  /**
   * The discussions and drafts of the merge request as threads in the code; throws when GitLab does not give
   * them. Counts the drafts and the comments of a newer version this one cannot show.
   */
  async threads(): Promise<ShownThread[]> {
    const [discussions, drafts] = await Promise.all([
      this.api.discussions(this.iid),
      this.api.draftNotes(this.iid),
    ]);
    // An outdated discussion stands in the version it was made on, and on the left of each comparison from
    // that version: GitLab keeps a discussion on the version after which its line changed.
    // While the review stays on this version, the discussions GitLab moved onto a newer one are followed back
    // onto it by the diff between the two, when their line is the same in both.
    const earlier = new Map<string, Place[]>();
    let newerOnly = 0;
    for (const discussion of discussions) {
      const position = discussion.notes.find((n) => !n.system)?.position;
      if (!position || position.headSha === this.refs.headSha) continue;
      const anchor = anchorOf(position);
      if (this.isNewer(position.headSha)) {
        const back = await this.backPlaceOf(anchor);
        if (back) earlier.set(discussion.id, [back]);
        else newerOnly++;
      }
      for (const interdiff of this.loadedInterdiffs) {
        if (interdiff.from.headSha !== position.headSha) continue;
        const place = await this.earlierPlaceOf(anchor, interdiff);
        if (place) earlier.set(discussion.id, [...(earlier.get(discussion.id) ?? []), place]);
      }
    }
    this.drafts = drafts.length;
    this.newerOnly = newerOnly;
    this.outdated.clear();

    const you = t('You');
    const draftNote = (draft: DraftNote): ShownNote => ({
      ref: { kind: 'draft', id: draft.id },
      author: you,
      text: draft.body,
      mine: true,
    });
    const draftReplies = new Map<string, DraftNote[]>();
    for (const draft of drafts) {
      if (draft.discussionId)
        draftReplies.set(draft.discussionId, [...(draftReplies.get(draft.discussionId) ?? []), draft]);
    }
    const threads: ShownThread[] = [];
    for (const discussion of discussions) {
      const thread = this.threadOf(discussion, earlier.get(discussion.id) ?? []);
      if (!thread) continue;
      thread.notes.push(...(draftReplies.get(discussion.id) ?? []).map(draftNote));
      threads.push(thread);
    }
    for (const draft of drafts) {
      if (draft.discussionId || !draft.position) continue;
      const anchor = anchorOf(draft.position);
      const place = placeIn(this.files, anchor);
      if (place)
        threads.push({
          ref: { kind: 'draft', id: draft.id },
          anchor,
          places: [place],
          notes: [draftNote(draft)],
          outdated: false,
        });
    }
    return threads;
  }

  private threadOf(discussion: Discussion, earlier: Place[]): ShownThread | undefined {
    const notes = discussion.notes.filter((n) => !n.system);
    const first = notes[0];
    if (!first?.position) return undefined;
    const anchor = anchorOf(first.position);
    const newer = this.isNewer(anchor.headSha);
    const outdated = anchor.headSha !== this.refs.headSha && !newer;
    const places: Place[] = [];
    if (outdated || newer) {
      if (outdated) this.outdated.set(discussion.id, anchor);
      places.push(versionPlaceOf(this.repository.root, anchor));
      for (const place of earlier) if (!places.some((p) => samePlace(p, place))) places.push(place);
    } else {
      const place = placeIn(this.files, anchor);
      if (place) places.push(place);
    }
    return {
      ref: { kind: 'discussion', id: discussion.id },
      anchor,
      places,
      notes: notes.map((n) => ({
        ref: { kind: 'note', discussionId: discussion.id, id: n.id },
        author: n.author.name,
        text: n.body,
        createdAt: n.createdAt,
        mine: n.author.username === this.me,
      })),
      resolved: first.resolvable ? first.resolved : undefined,
      outdated,
    };
  }

  /** A discussion GitLab moved onto a newer version, at the same line of the version under review. */
  private async backPlaceOf(anchor: Anchor): Promise<Place | undefined> {
    const file = this.files.find((f) => f.change.path === anchor.newPath);
    if (!file?.right) return undefined;
    const range = await followAnchor(this.repository, anchor, this.refs.headSha, file.change.path);
    return range && { uri: file.right, range };
  }

  /**
   * A discussion of an earlier version goes on the left side of a comparison from that version, so that the
   * comment stands next to how it was dealt with; after a rebase its line is followed onto the new base.
   */
  private async earlierPlaceOf(anchor: Anchor, since: Interdiff): Promise<Place | undefined> {
    const change = since.files.find((f) => (f.oldPath ?? f.path) === anchor.newPath);
    if (!change || change.status === 'A') return undefined;
    const range = await followAnchor(this.repository, anchor, since.left, anchor.newPath);
    return (
      range && { uri: revisionUri(this.repository.root, since.left, change.oldPath ?? change.path), range }
    );
  }

  /**
   * Where GitLab is to keep a comment typed on lines of the diff, and how to name them; undefined outside the
   * diff of the merge request.
   */
  async positionOf(
    uri: vscode.Uri,
    range: vscode.Range,
  ): Promise<{ position: DiffPosition; target: string } | undefined> {
    const placed = this.documents.get(uri.toString());
    if (!placed) return undefined;
    const line = range.end.line + 1;
    const first = range.start.line + 1;
    const { file, side } = placed;
    let hunks = this.hunks.get(file);
    if (!hunks) {
      hunks = this.repository.hunks(this.refs.baseSha, this.refs.headSha, file.change);
      this.hunks.set(file, hunks);
    }
    const resolved = await hunks;
    const end = linePair(resolved, side, line);
    const position: DiffPosition = {
      baseSha: this.refs.baseSha,
      startSha: this.refs.startSha,
      headSha: this.refs.headSha,
      oldPath: file.change.oldPath ?? file.change.path,
      newPath: file.change.path,
      ...end,
      lineRange:
        first < line
          ? {
              start: { ...linePair(resolved, side, first), counters: lineCounters(resolved, side, first) },
              end: { ...end, counters: lineCounters(resolved, side, line) },
            }
          : undefined,
    };
    const lines = first < line ? `${first}–${line}` : `${line}`;
    const target = `${side === 'new' ? file.change.path : position.oldPath}:${lines}${side === 'old' ? t(' (old version)') : ''}`;
    return { position, target };
  }
}

/** Version numbers by head; GitLab lists the versions newest first. */
async function versionNumbers(
  api: GitLabApi,
  iid: number,
  known: Map<string, number> = new Map(),
): Promise<Map<string, number>> {
  const versions = await api.versions(iid).catch(() => undefined);
  if (!versions) return known;
  return new Map([...versions].reverse().map((v, i) => [v.headSha, i + 1] as const));
}

/** Commits of the merge request may be missing locally: GitLab keeps them under `refs/merge-requests`. */
async function ensureCommits(
  repository: Repository,
  remote: string,
  iid: number,
  targetBranch: string,
  refs: DiffRefs,
): Promise<boolean> {
  const missing = async () =>
    !(await repository.revParse(refs.headSha)) || !(await repository.revParse(refs.baseSha));
  if (!(await missing())) return true;
  await repository.git
    .run(['fetch', remote, `refs/merge-requests/${iid}/head`, targetBranch], { timeoutMs: 120_000 })
    .catch(() => undefined);
  return !(await missing());
}
