import type * as vscode from 'vscode';

/** A version of a merge request: the diff `baseSha..headSha` GitLab shows for it. */
export interface Version {
  baseSha: string;
  headSha: string;
}

/** The version of each merge request reviewed last, to show what changed since then. */
const SEEN_KEY = 'kleio.review.seen';
const SEEN_LIMIT = 300;
const SEEN_VERSIONS = 50;

/** The versions of merge requests you looked at, by `host/project!iid`. */
export class SeenVersions {
  constructor(private readonly state: vscode.Memento) {}

  /** Oldest first. */
  of(label: string): Version[] {
    type Old = Version & { before?: Version };
    const stored = this.state.get<Record<string, Version[] | Old>>(SEEN_KEY, {})[label];
    if (!stored) return [];
    if (Array.isArray(stored)) return stored;
    return [...(stored.before ? [stored.before] : []), { baseSha: stored.baseSha, headSha: stored.headSha }];
  }

  /** The version looked at last before `head`, and whether `head` is new to you. */
  before(label: string, head: string): { previous?: Version; changed: boolean } {
    const seen = this.of(label);
    const previous = [...seen].reverse().find((v) => v.headSha !== head);
    return { previous, changed: seen.length > 0 && seen.at(-1)!.headSha !== head };
  }

  /** Remembers that you looked at a version: its diff was shown, not just its comments. */
  async mark(label: string, version: Version): Promise<void> {
    const seen = this.of(label);
    if (seen.at(-1)?.headSha === version.headSha) return;
    const versions = [...seen.filter((v) => v.headSha !== version.headSha), version].slice(-SEEN_VERSIONS);
    const all = this.state.get<Record<string, unknown>>(SEEN_KEY, {});
    const entries = Object.entries(all).filter(([key]) => key !== label);
    entries.push([label, versions]);
    await this.state.update(SEEN_KEY, Object.fromEntries(entries.slice(-SEEN_LIMIT)));
  }
}
