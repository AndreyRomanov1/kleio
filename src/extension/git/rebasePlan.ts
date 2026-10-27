import type { RebaseAction, RebaseEntry } from '../../shared/rebaseProtocol';
import { t } from '../../shared/l10n';

export interface RebaseTodo {
  /** Contents of the todo list given to `git rebase -i`. */
  todo: string;
  /** Message files to write before the rebase starts: file name → message. */
  messages: Map<string, string>;
}

/**
 * Turns the plan of the interactive rebase dialog into a git todo list that needs no editor: squash and fixup
 * become `fixup`, and every commit whose final message differs from its original one gets an `exec` that
 * amends the message from a prepared file, after the commit-msg hook. `messageFile` gives the path git should
 * read the n-th file from.
 *
 * `branches` (commit → local branches) are moved along with their commits by `update-ref` lines, as git's
 * `--update-refs` does, which a todo list written in place of git's own would lose. A branch moves after the
 * whole group of its commit, so that it gets the commit with the melded changes and the new message; a branch
 * of a dropped commit moves to the commit before it.
 */
export function buildRebaseTodo(
  entries: readonly RebaseEntry[],
  originals: ReadonlyMap<string, string>,
  messageFile: (name: string) => string,
  branches: ReadonlyMap<string, readonly string[]> = new Map(),
  /** Git before 2.36 has no `git hook run`: the commit-msg hook is then run by its path. */
  legacyHooks = false,
): RebaseTodo {
  const lines: string[] = [];
  const messages = new Map<string, string>();
  let pending: string | undefined;
  let refs: string[] = [];

  const flush = () => {
    if (pending !== undefined) {
      const name = `message-${messages.size + 1}.txt`;
      messages.set(name, pending);
      const file = quote(messageFile(name));
      // As a reword in git itself: the commit-msg hook checks the message, pre-commit does not run again.
      const hook = legacyHooks
        ? `hook="$(git rev-parse --git-path hooks/commit-msg)" && { [ ! -x "$hook" ] || "$hook" ${file}; }`
        : `git hook run --ignore-missing commit-msg -- ${file}`;
      lines.push(
        `exec ${hook} && git commit --amend --allow-empty --no-verify --quiet --cleanup=whitespace -F ${file}`,
      );
      pending = undefined;
    }
    for (const ref of refs) lines.push(`update-ref refs/heads/${ref}`);
    refs = [];
  };

  let started = false;
  for (const entry of entries) {
    const moved = branches.get(entry.hash) ?? [];
    if (entry.action === 'drop') {
      lines.push(`drop ${entry.hash}`);
      refs.push(...moved);
      if (!started) flush();
      continue;
    }
    if (isMeld(entry.action)) {
      if (!started) throw new Error(t('The first commit cannot be melded into the previous one.'));
      lines.push(`fixup ${entry.hash}`);
      refs.push(...moved);
      continue;
    }
    flush();
    started = true;
    lines.push(`${entry.action === 'edit' ? 'edit' : 'pick'} ${entry.hash}`);
    refs.push(...moved);
    const message = entry.message?.trim();
    // A group with squashed commits always takes the message chosen in the dialog.
    const group = groupOf(entries, entry);
    if (
      message &&
      (message !== originals.get(entry.hash)?.trim() || group.some((e) => e.action === 'squash'))
    ) {
      pending = message;
    }
  }
  flush();
  return { todo: lines.join('\n') + '\n', messages };
}

function isMeld(action: RebaseAction): boolean {
  return action === 'squash' || action === 'fixup';
}

/** Commits melded into the given one: the squash and fixup entries right after it, skipping dropped ones. */
function groupOf(entries: readonly RebaseEntry[], head: RebaseEntry): RebaseEntry[] {
  const result: RebaseEntry[] = [];
  for (let i = entries.indexOf(head) + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.action === 'drop') continue;
    if (!isMeld(entry.action)) break;
    result.push(entry);
  }
  return result;
}

/** Quotes a path for the shell git runs `exec` lines in; forward slashes work there on Windows too. */
function quote(filePath: string): string {
  return `'${filePath.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
}
