import type { Commit, Ref, Worktree } from '../shared/model';
import type { ChangeSetView } from '../shared/protocol';
import type { MenuEntry } from './menu.svelte';
import type { LogStore } from './store.svelte';
import { post } from './vscode';

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
    { label: 'Копировать хэш', run: action({ type: 'commitAction', action: 'copyHash', hash }) },
    { label: 'Копировать заголовок', run: action({ type: 'commitAction', action: 'copySubject', hash }) },
    'separator',
    {
      label: 'Checkout ревизии (без ветки)',
      run: action({ type: 'commitAction', action: 'checkout', hash }),
    },
    { label: 'Новая ветка…', run: action({ type: 'commitAction', action: 'newBranch', hash }) },
    { label: 'Новый тег…', run: action({ type: 'commitAction', action: 'newTag', hash }) },
    'separator',
    { label: 'Revert коммита', run: action({ type: 'commitAction', action: 'revert', hash }) },
    'separator',
    {
      label: 'Сравнить с рабочей копией',
      run: action({ type: 'commitAction', action: 'compareWithWorktree', hash }),
    },
    ...hostingEntries(store, [
      {
        label: `Открыть в ${store.hosting?.name}`,
        icon: 'link-external',
        run: action({ type: 'commitAction', action: 'openInHosting', hash }),
      },
      {
        label: `Копировать ссылку на ${store.hosting?.name}`,
        run: action({ type: 'commitAction', action: 'copyHostingLink', hash }),
      },
    ]),
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
  const favorite = store.favorites.includes(fullName);
  const focused = store.focus.includes(ref.name);
  const worktree =
    ref.kind === 'head'
      ? store.snapshot?.worktrees.find((w) => w.branch === ref.name && !w.isCurrent)
      : undefined;
  const entries: MenuEntry[] = worktree
    ? [
        {
          label: `Открыть worktree ${worktree.path.split(/[\\/]/).pop()} в новом окне`,
          icon: 'empty-window',
          run: () => post({ type: 'openWorktree', path: worktree.path, newWindow: true }),
        },
        {
          label: 'Открыть worktree в этом окне',
          run: () => post({ type: 'openWorktree', path: worktree.path, newWindow: false }),
        },
        'separator',
      ]
    : [];
  entries.push(
    {
      label: ref.kind === 'remote' ? 'Checkout (локальная ветка = origin)' : 'Checkout',
      disabled: isCurrent || !!worktree,
      run: run({ type: 'refAction', action: 'checkout', fullName }),
    },
    { label: 'Новая ветка отсюда…', run: run({ type: 'refAction', action: 'newBranch', fullName }) },
    'separator',
    {
      label: 'Сравнить с текущей',
      disabled: isCurrent,
      run: run({ type: 'refAction', action: 'showDiffWithCurrent', fullName }),
    },
  );
  if (ref.kind === 'remote' || ref.upstream) {
    entries.push({ label: 'Fetch ветки', run: run({ type: 'refAction', action: 'fetchBranch', fullName }) });
  }
  const mergeRequest = store.hosting?.mergeRequests[ref.hash]?.[0];
  const defaultBranch = store.hosting?.defaultBranch;
  const isDefault =
    defaultBranch === ref.name || defaultBranch?.slice(defaultBranch.indexOf('/') + 1) === ref.name;
  if (ref.kind !== 'tag') {
    entries.push(
      ...hostingEntries(store, [
        mergeRequest
          ? {
              label: `Открыть MR !${mergeRequest}`,
              icon: 'git-pull-request',
              run: () => post({ type: 'openMergeRequest', number: mergeRequest }),
            }
          : {
              label: 'Создать MR…',
              icon: 'git-pull-request-create',
              disabled: isDefault,
              run: run({ type: 'refAction', action: 'createMergeRequest', fullName }),
            },
        {
          label: `Открыть в ${store.hosting?.name}`,
          icon: 'link-external',
          disabled: ref.kind === 'head' && !ref.upstream,
          run: run({ type: 'refAction', action: 'openInHosting', fullName }),
        },
      ]),
    );
  }
  entries.push(
    'separator',
    {
      label: favorite ? 'Убрать из избранного' : 'В избранное',
      run: () => post({ type: 'toggleFavorite', fullName }),
    },
    {
      label: focused ? 'Убрать из фокуса' : 'Добавить в фокус',
      run: () => toggleFocus(store, ref.name),
    },
    { label: 'Показать только эту ветку', run: () => post({ type: 'setFocus', revisions: [ref.name] }) },
    'separator',
    { label: 'Копировать имя', run: run({ type: 'refAction', action: 'copyName', fullName }) },
  );
  if (ref.kind === 'head') {
    entries.push({
      label: 'Удалить ветку…',
      disabled: isCurrent,
      run: run({ type: 'refAction', action: 'deleteBranch', fullName }),
    });
  }
  if (ref.kind === 'remote') {
    entries.push({
      label: `Удалить ветку в ${ref.name.slice(0, ref.name.indexOf('/'))}…`,
      run: run({ type: 'refAction', action: 'deleteRemoteBranch', fullName }),
    });
  }
  return entries;
}

export function worktreeMenu(worktree: Worktree): MenuEntry[] {
  return [
    {
      label: 'Открыть в новом окне',
      disabled: worktree.isCurrent,
      run: () => post({ type: 'openWorktree', path: worktree.path, newWindow: true }),
    },
    {
      label: 'Открыть в этом окне',
      disabled: worktree.isCurrent,
      run: () => post({ type: 'openWorktree', path: worktree.path, newWindow: false }),
    },
  ];
}

export function fileMenu(changeSet: ChangeSetView, index: number): MenuEntry[] {
  const run =
    (action: 'openDiff' | 'openCurrent' | 'openRevision' | 'compareWithWorktree' | 'copyPath') => () =>
      post({ type: 'fileAction', action, changeSetId: changeSet.id, index });
  const deleted = changeSet.files[index]?.status === 'D';
  return [
    { label: 'Показать diff', hint: 'двойной клик', run: run('openDiff') },
    { label: 'Открыть текущую версию', hint: 'F4', disabled: deleted, run: run('openCurrent') },
    { label: 'Открыть версию из ревизии', run: run('openRevision') },
    { label: 'Сравнить с рабочей копией', run: run('compareWithWorktree') },
    'separator',
    { label: 'Копировать путь', run: run('copyPath') },
  ];
}

export function toggleFocus(store: LogStore, revision: string): void {
  const revisions = store.focus.includes(revision)
    ? store.focus.filter((r) => r !== revision)
    : [...store.focus, revision];
  post({ type: 'setFocus', revisions });
}
