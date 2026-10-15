import { linkify } from '../shared/linkify';
import type { Commit, Ref, Worktree } from '../shared/model';
import type { ChangeSetView } from '../shared/protocol';
import type { MenuEntry } from './menu.svelte';
import type { LogStore } from './store.svelte';
import { post } from './vscode';
import { t } from '../shared/l10n';

const refIcons: Record<Ref['kind'], string> = { head: 'git-branch', remote: 'cloud', tag: 'tag' };

/** Branches pointing at the commit come first, each with its own actions, as in Rider. */
export function commitMenu(commit: Commit, store: LogStore): MenuEntry[] {
  const action = (a: Parameters<typeof post>[0] & { type: 'commitAction' }) => () => post(a);
  const hash = commit.hash;
  const order = { head: 0, remote: 1, tag: 2 };
  const refs = [...(store.decorations.get(hash)?.refs ?? [])].sort((a, b) => order[a.kind] - order[b.kind]);
  const branchEntries: MenuEntry[] = refs.map((ref) => ({
    label: ref.name,
    icon: refIcons[ref.kind],
    submenu: refMenu(ref, store),
  }));
  return [
    ...branchEntries,
    ...(branchEntries.length ? (['separator'] as const) : []),
    { label: t('Copy hash'), run: action({ type: 'commitAction', action: 'copyHash', hash }) },
    { label: t('Copy subject'), run: action({ type: 'commitAction', action: 'copySubject', hash }) },
    ...(store.history
      ? []
      : [
          {
            label: t('Show only commits by {0}', commit.authorName),
            icon: 'filter',
            run: () => post({ type: 'setQuery', query: { ...store.query, authors: [commit.authorEmail] } }),
          },
        ]),
    { label: t('Save as patch…'), run: action({ type: 'commitAction', action: 'savePatch', hash }) },
    'separator',
    {
      label: t('Checkout revision (no branch)'),
      run: action({ type: 'commitAction', action: 'checkout', hash }),
    },
    { label: t('New branch…'), run: action({ type: 'commitAction', action: 'newBranch', hash }) },
    { label: t('New tag…'), run: action({ type: 'commitAction', action: 'newTag', hash }) },
    'separator',
    ...rewriteEntries(commit, store),
    'separator',
    {
      label: t('Cherry-pick into the current branch'),
      disabled: store.decorations.get(hash)?.isHead,
      run: action({ type: 'commitAction', action: 'cherryPick', hash }),
    },
    { label: t('Revert commit'), run: action({ type: 'commitAction', action: 'revert', hash }) },
    {
      label: t('Reset {0} to here…', store.snapshot?.head.branch ?? 'HEAD'),
      run: action({ type: 'commitAction', action: 'reset', hash }),
    },
    'separator',
    {
      label: t('Compare with the working tree'),
      run: action({ type: 'commitAction', action: 'compareWithWorktree', hash }),
    },
    ...hostingEntries(store, [
      {
        label: t('Open in {0}', store.hosting?.name ?? ''),
        icon: 'link-external',
        run: action({ type: 'commitAction', action: 'openInHosting', hash }),
      },
      {
        label: t('Copy {0} link', store.hosting?.name ?? ''),
        run: action({ type: 'commitAction', action: 'copyHostingLink', hash }),
      },
    ]),
  ];
}

/**
 * Rider's history rewriting from the log: interactive rebase from a commit, a new message, fixup into the
 * previous commit, drop; with several commits selected — squash or drop them all.
 */
function rewriteEntries(commit: Commit, store: LogStore): MenuEntry[] {
  const action = (a: Parameters<typeof post>[0] & { type: 'commitAction' }) => () => post(a);
  const hash = commit.hash;
  const ours = store.headAncestors.has(hash) && !store.snapshot?.operation;
  const merge = commit.parents.length > 1;
  const selection = store.selected.has(hash) ? [...store.selected] : [hash];
  if (selection.length > 1) {
    const allOurs = ours && selection.every((h) => store.headAncestors.has(h));
    return [
      {
        label: t('Squash {0} commits…', selection.length),
        icon: 'fold',
        disabled: !allOurs,
        run: () => post({ type: 'commitsAction', action: 'squash', hashes: selection }),
      },
      {
        label: t('Drop {0} commits…', selection.length),
        disabled: !allOurs,
        run: () => post({ type: 'commitsAction', action: 'drop', hashes: selection }),
      },
      'separator',
      {
        label: t('Cherry-pick {0} commits into the current branch', selection.length),
        disabled: !store.snapshot?.head.branch || !!store.snapshot?.operation,
        run: () => post({ type: 'commitsAction', action: 'cherryPick', hashes: selection }),
      },
      {
        label: t('Save {0} commits as a patch…', selection.length),
        run: () => post({ type: 'commitsAction', action: 'savePatch', hashes: selection }),
      },
    ];
  }
  return [
    {
      label: t('Interactive rebase from here…'),
      icon: 'git-pull-request-draft',
      disabled: !ours || merge,
      run: action({ type: 'commitAction', action: 'interactiveRebase', hash }),
    },
    {
      label: t('Edit message…'),
      icon: 'edit',
      disabled: !ours || merge,
      run: action({ type: 'commitAction', action: 'reword', hash }),
    },
    {
      label: t('Meld into the previous one (fixup)'),
      disabled: !ours || merge || commit.parents.length === 0,
      run: action({ type: 'commitAction', action: 'fixupIntoParent', hash }),
    },
    {
      label: t('Drop commit…'),
      disabled: !ours || merge,
      run: () => post({ type: 'commitsAction', action: 'drop', hashes: [hash] }),
    },
  ];
}

/** Entries that need a known hosting, with a separator before them. */
function hostingEntries(store: LogStore, entries: MenuEntry[]): MenuEntry[] {
  return store.hosting?.name ? ['separator', ...entries] : [];
}

export function refMenu(ref: Ref, store: LogStore): MenuEntry[] {
  const run = (action: Parameters<typeof post>[0] & { type: 'refAction' }) => () => post(action);
  const fullName = ref.fullName;
  const isCurrent = ref.kind === 'head' && store.snapshot?.head.branch === ref.name;
  const current = store.snapshot?.head.branch;
  const favorite = store.favorites.includes(fullName);
  const focused = store.focus.includes(ref.name);
  const worktree =
    ref.kind === 'head'
      ? store.snapshot?.worktrees.find((w) => w.branch === ref.name && !w.isCurrent)
      : undefined;
  const entries: MenuEntry[] = worktree
    ? [
        {
          label: t('Open worktree {0} in a new window', worktree.path.split(/[\\/]/).pop() ?? ''),
          icon: 'empty-window',
          run: () => post({ type: 'openWorktree', path: worktree.path, newWindow: true }),
        },
        {
          label: t('Open the worktree in this window'),
          run: () => post({ type: 'openWorktree', path: worktree.path, newWindow: false }),
        },
        'separator',
      ]
    : [];
  entries.push(
    {
      label: ref.kind === 'remote' ? t('Checkout (local branch = remote)') : 'Checkout',
      disabled: isCurrent || !!worktree,
      run: run({ type: 'refAction', action: 'checkout', fullName }),
    },
    {
      label: t('Checkout into a new worktree…'),
      icon: 'new-folder',
      disabled: isCurrent || !!worktree || ref.kind === 'tag',
      run: run({ type: 'refAction', action: 'checkoutToWorktree', fullName }),
    },
    { label: t('New branch from here…'), run: run({ type: 'refAction', action: 'newBranch', fullName }) },
    'separator',
    ...syncEntries(ref, store, isCurrent),
    'separator',
    {
      label: t('Compare with the current branch'),
      disabled: isCurrent,
      run: run({ type: 'refAction', action: 'showDiffWithCurrent', fullName }),
    },
    ...(current && !isCurrent
      ? [
          {
            label: t('Commits of {0} missing in {1}', ref.name, current),
            run: () => post({ type: 'setFocus', revisions: [`${current}..${ref.name}`] }),
          },
          {
            label: t('Commits of {0} missing in {1}', current, ref.name),
            run: () => post({ type: 'setFocus', revisions: [`${ref.name}..${current}`] }),
          },
        ]
      : []),
  );
  if (ref.kind === 'remote' || ref.upstream) {
    entries.push({
      label: t('Fetch branch'),
      run: run({ type: 'refAction', action: 'fetchBranch', fullName }),
    });
  }
  const mergeRequest = store.hosting?.mergeRequests[ref.hash]?.[0];
  const defaultBranch = store.hosting?.defaultBranch;
  const isDefault =
    defaultBranch === ref.name || defaultBranch?.slice(defaultBranch.indexOf('/') + 1) === ref.name;
  // Links found in the branch name by the autolink rules, e.g. the ticket of `PROJ-1234`.
  const branchLinks = linkify(ref.name, store.hosting?.autolinks ?? []).filter((p) => p.url);
  if (branchLinks.length) {
    entries.push(
      'separator',
      ...branchLinks.map((link): MenuEntry => ({
        label: t('Open {0}', link.text),
        icon: 'link-external',
        run: () => post({ type: 'openUrl', url: link.url! }),
      })),
    );
  }
  if (ref.kind !== 'tag') {
    entries.push(
      ...hostingEntries(store, [
        ...(mergeRequest
          ? [
              {
                label:
                  store.hosting?.kind === 'github'
                    ? t('Pull request #{0}: changes', mergeRequest)
                    : t('Review merge request !{0}', mergeRequest),
                icon: 'eye',
                run: () => post({ type: 'startReview', number: mergeRequest }),
              },
              {
                label:
                  store.hosting?.kind === 'github'
                    ? t('Open pull request #{0}', mergeRequest)
                    : t('Open merge request !{0}', mergeRequest),
                icon: 'git-pull-request',
                run: () => post({ type: 'openMergeRequest', number: mergeRequest }),
              },
            ]
          : [
              {
                label: t('Create merge request…'),
                icon: 'git-pull-request-create',
                disabled: isDefault,
                run: run({ type: 'refAction', action: 'createMergeRequest', fullName }),
              },
            ]),
        {
          label: t('Open in {0}', store.hosting?.name ?? ''),
          icon: 'link-external',
          // A local branch is on the server when it tracks one or a remote branch of the same name exists.
          disabled:
            ref.kind === 'head' &&
            !ref.upstream &&
            !store.snapshot?.refs.some(
              (r) => r.kind === 'remote' && r.name.slice(r.name.indexOf('/') + 1) === ref.name,
            ),
          run: run({ type: 'refAction', action: 'openInHosting', fullName }),
        },
      ]),
    );
  }
  entries.push(
    'separator',
    {
      label: favorite ? t('Remove from favorites') : t('Add to favorites'),
      run: () => post({ type: 'toggleFavorite', fullName }),
    },
    {
      label: focused ? t('Remove from focus') : t('Add to focus'),
      run: () => toggleFocus(store, ref.name),
    },
    { label: t('Show only this branch'), run: () => post({ type: 'setFocus', revisions: [ref.name] }) },
    'separator',
    { label: t('Copy name'), run: run({ type: 'refAction', action: 'copyName', fullName }) },
  );
  if (ref.kind === 'head') {
    entries.push(
      { label: t('Rename…'), run: run({ type: 'refAction', action: 'rename', fullName }) },
      {
        label: t('Track a remote branch…'),
        run: run({ type: 'refAction', action: 'setUpstream', fullName }),
      },
      {
        label: t('Delete branch…'),
        disabled: isCurrent,
        run: run({ type: 'refAction', action: 'deleteBranch', fullName }),
      },
    );
  }
  if (ref.kind === 'tag') {
    entries.push(
      {
        label: t('Push tag'),
        icon: 'repo-push',
        run: run({ type: 'refAction', action: 'pushTag', fullName }),
      },
      { label: t('Delete tag…'), run: run({ type: 'refAction', action: 'deleteTag', fullName }) },
    );
  }
  if (ref.kind === 'remote') {
    entries.push({
      label: t('Delete branch on {0}…', ref.name.slice(0, ref.name.indexOf('/'))),
      run: run({ type: 'refAction', action: 'deleteRemoteBranch', fullName }),
    });
  }
  return entries;
}

/** Merge, rebase, update and push, named after the current branch as in Rider. */
function syncEntries(ref: Ref, store: LogStore, isCurrent: boolean): MenuEntry[] {
  const run = (action: Parameters<typeof post>[0] & { type: 'refAction' }) => () => post(action);
  const fullName = ref.fullName;
  const current = store.snapshot?.head.branch;
  const busy = !!store.snapshot?.operation;
  const entries: MenuEntry[] = [];
  if (!isCurrent && current) {
    entries.push(
      {
        label: t('Merge {0} into {1}', ref.name, current),
        icon: 'git-merge',
        disabled: busy,
        run: run({ type: 'refAction', action: 'merge', fullName }),
      },
      {
        label: t('Rebase {0} onto {1}', current, ref.name),
        disabled: busy,
        run: run({ type: 'refAction', action: 'rebaseOnto', fullName }),
      },
    );
    if (ref.kind === 'head') {
      entries.push({
        label: t('Checkout {0} and rebase it onto {1}', ref.name, current),
        disabled: busy,
        run: run({ type: 'refAction', action: 'checkoutAndRebase', fullName }),
      });
    }
  }
  if (ref.kind === 'head') {
    entries.push({
      label: isCurrent
        ? t('Update (fetch and pull from the remote)')
        : t('Update from the remote without checkout'),
      icon: 'repo-pull',
      disabled: !ref.upstream || busy,
      run: run({ type: 'refAction', action: 'updateBranch', fullName }),
    });
    entries.push({
      label: 'Push…',
      icon: 'repo-push',
      run: run({ type: 'refAction', action: 'push', fullName }),
    });
  }
  return entries;
}

export function worktreeMenu(worktree: Worktree): MenuEntry[] {
  return [
    {
      label: t('Open in a new window'),
      disabled: worktree.isCurrent,
      run: () => post({ type: 'openWorktree', path: worktree.path, newWindow: true }),
    },
    {
      label: t('Open in this window'),
      disabled: worktree.isCurrent,
      run: () => post({ type: 'openWorktree', path: worktree.path, newWindow: false }),
    },
  ];
}

export function fileMenu(
  changeSet: ChangeSetView,
  index: number,
  onfilterpath?: (path: string) => void,
): MenuEntry[] {
  const run =
    (action: 'openDiff' | 'openCurrent' | 'openRevision' | 'compareWithWorktree' | 'copyPath') => () =>
      post({ type: 'fileAction', action, changeSetId: changeSet.id, index });
  const deleted = changeSet.files[index]?.status === 'D';
  return [
    { label: t('Show diff'), hint: t('double-click'), run: run('openDiff') },
    { label: t('Open the current version'), hint: 'F4', disabled: deleted, run: run('openCurrent') },
    { label: t('Open the version of the revision'), run: run('openRevision') },
    { label: t('Compare with the working tree'), run: run('compareWithWorktree') },
    'separator',
    ...(onfilterpath && changeSet.files[index]
      ? [
          {
            label: t('Show only commits changing this file'),
            icon: 'filter',
            run: () => onfilterpath(changeSet.files[index].path),
          },
        ]
      : []),
    { label: t('Copy path'), run: run('copyPath') },
  ];
}

export function toggleFocus(store: LogStore, revision: string): void {
  const revisions = store.focus.includes(revision)
    ? store.focus.filter((r) => r !== revision)
    : [...store.focus, revision];
  post({ type: 'setFocus', revisions });
}
