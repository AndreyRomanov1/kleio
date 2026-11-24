import type { ChangeSet } from '../changes/changeSet';
import type { Repository } from '../git/repository';
import type { Anchor, ReviewFile } from './anchor';
import type { Version } from './mergeRequest/seenVersions';
import type { Side } from './positions';
import type { ShownThread } from './threadBoard';

/** What the review shows whoever keeps its threads: a merge request, a branch or a range of commits. */
export interface ReviewSession {
  readonly repository: Repository;
  /** The diff under review. */
  readonly changeSet: ChangeSet;
  /** Document URI → file and side, for placing comments. */
  readonly documents: ReadonlyMap<string, { file: ReviewFile; side: Side }>;
  /** Threads made on an earlier version whose lines changed since, by thread: where they were made. */
  readonly outdated: ReadonlyMap<string, Anchor>;
  /** Comparisons between versions, each with its own comments. */
  readonly interdiffSets: readonly ChangeSet[];
  /** The diffs of the review: its own and those worked out for it. */
  ownSets(): ChangeSet[];
  /** The diff of an earlier version, where its outdated threads stand. */
  versionOf(version: Version): Promise<ChangeSet | undefined>;
  /** The threads in the code; throws when they cannot be had. */
  threads(): Promise<ShownThread[]>;
}
