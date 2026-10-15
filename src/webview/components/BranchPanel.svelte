<script lang="ts">
  import type { Ref, Stash, Worktree } from '../../shared/model';
  import { basename, formatDate } from '../format';
  import { menu } from '../menu.svelte';
  import { refMenu, toggleFocus, worktreeMenu } from '../menus';
  import type { LogStore } from '../store.svelte';
  import { mergeRequestStateLabel, mergeRequestTone } from '../hostingView';
  import { buildTree, flatten, type TreeNode } from '../tree';
  import { post } from '../vscode';

  interface Props {
    store: LogStore;
    collapsed: ReadonlySet<string>;
    ontoggle: (key: string) => void;
  }

  let { store, collapsed, ontoggle }: Props = $props();
  let query = $state('');

  type Entry =
    | { kind: 'ref'; ref: Ref }
    | { kind: 'worktree'; worktree: Worktree }
    | { kind: 'stash'; stash: Stash }
    | { kind: 'detached'; hash: string };

  interface Section {
    key: string;
    title: string;
    nodes: TreeNode<Entry>[];
  }

  const leaf = (key: string, label: string, item: Entry): TreeNode<Entry> => ({
    kind: 'leaf',
    key,
    label,
    item,
  });

  const sections = $derived.by((): Section[] => {
    const snapshot = store.snapshot;
    if (!snapshot) return [];
    const text = query.trim().toLowerCase();
    const matches = (name: string) => !text || name.toLowerCase().includes(text);
    const refs = snapshot.refs.filter((r) => matches(r.name));
    const byKind = (kind: Ref['kind']) => refs.filter((r) => r.kind === kind);
    const result: Section[] = [];

    const current = snapshot.refs.find((r) => r.kind === 'head' && r.name === snapshot.head.branch);
    if (current)
      result.push({
        key: 'section:head',
        title: 'HEAD',
        nodes: [leaf('head', current.name, { kind: 'ref', ref: current })],
      });
    else if (snapshot.head.hash)
      result.push({
        key: 'section:head',
        title: 'HEAD',
        nodes: [
          leaf(
            'head',
            snapshot.operation?.kind === 'rebase' && snapshot.operation.branch
              ? `${snapshot.head.hash.slice(0, 8)} (идёт rebase ${snapshot.operation.branch})`
              : `${snapshot.head.hash.slice(0, 8)} (без ветки)`,
            {
              kind: 'detached',
              hash: snapshot.head.hash,
            },
          ),
        ],
      });

    const favorites = refs.filter((r) => store.favorites.includes(r.fullName));
    if (favorites.length) {
      result.push({
        key: 'section:favorites',
        title: 'Избранные',
        nodes: favorites.map((r) => leaf(`favorite:${r.fullName}`, r.name, { kind: 'ref', ref: r })),
      });
    }

    const toTree = (items: Ref[], prefix: string) =>
      buildTree(
        items.map((ref): Entry => ({ kind: 'ref', ref })),
        (e) => (e as { ref: Ref }).ref.name,
        prefix,
      );
    result.push({ key: 'section:local', title: 'Локальные', nodes: toTree(byKind('head'), 'local') });
    const detached = snapshot.worktrees.filter((w) => !w.branch && !w.isCurrent && matches(w.path));
    if (detached.length) {
      result.push({
        key: 'section:worktrees',
        title: 'Worktree без ветки',
        nodes: detached.map((w) =>
          leaf(`worktree:${w.path}`, basename(w.path), { kind: 'worktree', worktree: w }),
        ),
      });
    }
    result.push({ key: 'section:remote', title: 'Удалённые', nodes: toTree(byKind('remote'), 'remote') });

    const stashes = snapshot.stashes.filter((s) => matches(s.message));
    if (stashes.length) {
      result.push({
        key: 'section:stashes',
        title: 'Stash',
        nodes: stashes.map((s) => leaf(`stash:${s.selector}`, s.message, { kind: 'stash', stash: s })),
      });
    }

    const tags = byKind('tag');
    if (tags.length) result.push({ key: 'section:tags', title: 'Теги', nodes: toTree(tags, 'tags') });
    return result;
  });

  const effectiveCollapsed = $derived(query.trim() ? new Set<string>() : collapsed);

  function activate(entry: Entry): void {
    switch (entry.kind) {
      case 'ref':
        store.reveal(entry.ref.hash);
        break;
      case 'worktree':
        if (entry.worktree.head) store.reveal(entry.worktree.head);
        break;
      case 'stash':
        store.showStash(entry.stash);
        break;
      case 'detached':
        store.reveal(entry.hash);
        break;
    }
  }

  function contextMenu(event: MouseEvent, entry: Entry): void {
    if (entry.kind === 'ref') menu.show(event, refMenu(entry.ref, store));
    else if (entry.kind === 'worktree') menu.show(event, worktreeMenu(entry.worktree));
  }

  /** A local branch fully merged into the default one, other than the current and the default branch itself. */
  function isMerged(ref: Ref): boolean {
    const hosting = store.hosting;
    if (ref.kind !== 'head' || !hosting?.merged.includes(ref.name)) return false;
    if (store.snapshot?.head.branch === ref.name) return false;
    return hosting.defaultBranch?.slice(hosting.defaultBranch.indexOf('/') + 1) !== ref.name;
  }

  function worktreeOf(ref: Ref): Worktree | undefined {
    if (ref.kind !== 'head') return undefined;
    return store.snapshot?.worktrees.find((w) => w.branch === ref.name && !w.isCurrent);
  }
</script>

<div class="panel">
  <input
    id="kleio-branch-search"
    class="search"
    placeholder="Поиск веток"
    bind:value={query}
    spellcheck="false"
    onkeydown={(e) => {
      if (e.key !== 'Escape') return;
      if (query) query = '';
      else (e.currentTarget as HTMLElement).blur();
    }}
  />
  <div class="tree" role="tree">
    {#each sections as section (section.key)}
      {@const open = !effectiveCollapsed.has(section.key)}
      <button class="section" onclick={() => ontoggle(section.key)} aria-expanded={open}>
        <i class="chevron codicon codicon-chevron-{open ? 'down' : 'right'}"></i>{section.title}
      </button>
      {#if open}
        {#each flatten(section.nodes, effectiveCollapsed) as { node, depth } (node.key)}
          {#if node.kind === 'folder'}
            <button
              class="node folder"
              style:padding-left="{14 + depth * 14}px"
              onclick={() => ontoggle(node.key)}
              aria-expanded={!effectiveCollapsed.has(node.key)}
            >
              <i class="chevron codicon codicon-chevron-{effectiveCollapsed.has(node.key) ? 'right' : 'down'}"
              ></i>
              <i class="codicon codicon-folder"></i>{node.label}
            </button>
          {:else}
            {@const entry = node.item}
            <div
              class="node leaf"
              style:padding-left="{26 + depth * 14}px"
              role="treeitem"
              aria-selected="false"
              tabindex="-1"
              onclick={() => activate(entry)}
              onkeydown={(e) => e.key === 'Enter' && activate(entry)}
              oncontextmenu={(e) => contextMenu(e, entry)}
            >
              {#if entry.kind === 'ref'}
                {@const ref = entry.ref}
                {@const focused = store.focus.includes(ref.name)}
                {@const worktree = worktreeOf(ref)}
                {@const mergeRequest = store.hosting?.mergeRequests[ref.hash]?.[0]}
                {@const merged = isMerged(ref)}
                <span
                  class="label"
                  class:current={ref.kind === 'head' && store.snapshot?.head.branch === ref.name}
                  class:merged
                  title={merged
                    ? `${ref.name} — влита в ${store.hosting?.defaultBranch}, можно удалить`
                    : ref.name}>{node.label}</span
                >
                {#if worktree}<i
                    class="info codicon codicon-repo"
                    title="Ветка открыта в worktree {worktree.path} — ПКМ, чтобы открыть"
                  ></i>{/if}
                {#if mergeRequest}
                  {@const info = store.hosting?.mergeRequestInfo[mergeRequest]}
                  <button
                    class="mr {mergeRequestTone(info)}"
                    title={info
                      ? `!${mergeRequest} · ${mergeRequestStateLabel(info)} · ${info.title}`
                      : `Merge request !${mergeRequest}`}
                    onclick={(e) => {
                      e.stopPropagation();
                      store.openCard(mergeRequest);
                    }}>!{mergeRequest}</button
                  >{/if}
                {#if ref.upstreamGone}<span class="info gone" title="Ветка в origin удалена">origin</span
                  >{/if}
                {#if ref.ahead}<span class="info ahead" title="Не отправлено в origin">↑{ref.ahead}</span
                  >{/if}
                {#if ref.behind}<span class="info behind" title="Новое в origin">↓{ref.behind}</span>{/if}
                <span class="actions">
                  <button
                    class="icon"
                    class:on={store.favorites.includes(ref.fullName)}
                    title="Избранное"
                    onclick={(e) => {
                      e.stopPropagation();
                      post({ type: 'toggleFavorite', fullName: ref.fullName });
                    }}><i class="codicon codicon-star-full"></i></button
                  >
                  <button
                    class="icon"
                    class:on={focused}
                    title={focused
                      ? 'Убрать из фокуса'
                      : 'Добавить в фокус: лог покажет только ветки в фокусе'}
                    onclick={(e) => {
                      e.stopPropagation();
                      toggleFocus(store, ref.name);
                    }}><i class="codicon codicon-filter{focused ? '-filled' : ''}"></i></button
                  >
                </span>
              {:else if entry.kind === 'worktree'}
                {@const w = entry.worktree}
                <span class="label" class:current={w.isCurrent} title={w.path}>{node.label}</span>
                <span class="info">{w.branch ?? w.head?.slice(0, 8) ?? ''}</span>
                {#if w.isCurrent}<span class="info">это окно</span>{/if}
              {:else if entry.kind === 'stash'}
                <span class="label" title={entry.stash.message}>{node.label}</span>
                <span class="info">{formatDate(entry.stash.date)}</span>
              {:else}
                <span class="label current">{node.label}</span>
              {/if}
            </div>
          {/if}
        {/each}
      {/if}
    {/each}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }
  .search {
    flex: none;
    margin: 4px;
  }
  .tree {
    flex: 1;
    overflow: auto;
    padding-bottom: 8px;
  }
  .section,
  .node {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    height: 22px;
    padding: 0 6px;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .section {
    font-weight: 600;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.8;
    margin-top: 4px;
  }
  .node:hover,
  .section:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .chevron {
    width: 12px;
    flex: none;
    opacity: 0.7;
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .label.current {
    font-weight: 600;
  }
  .info {
    flex: none;
    font-size: 0.85em;
    opacity: 0.7;
  }
  .label.merged {
    opacity: 0.55;
  }
  .mr {
    flex: none;
    padding: 0 4px;
    border: none;
    border-radius: 3px;
    background: color-mix(in srgb, var(--vscode-charts-orange) 22%, transparent);
    color: inherit;
    font: inherit;
    font-size: 0.85em;
    cursor: pointer;
  }
  .mr.draft {
    background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  }
  .mr.merged {
    background: color-mix(in srgb, var(--vscode-charts-purple) 25%, transparent);
  }
  .mr.closed {
    opacity: 0.6;
    text-decoration: line-through;
  }
  .mr:hover {
    background: color-mix(in srgb, var(--vscode-charts-orange) 40%, transparent);
  }
  .gone {
    text-decoration: line-through;
  }
  .ahead {
    color: var(--vscode-gitDecoration-addedResourceForeground);
    opacity: 1;
  }
  .behind {
    color: var(--vscode-gitDecoration-modifiedResourceForeground);
    opacity: 1;
  }
  .actions {
    margin-left: auto;
    display: flex;
    flex: none;
  }
  .icon {
    border: none;
    background: none;
    color: inherit;
    padding: 0 3px;
    cursor: pointer;
    visibility: hidden;
    opacity: 0.5;
  }
  .icon.on {
    visibility: visible;
    opacity: 1;
    color: var(--vscode-charts-yellow);
  }
  .node:hover .icon {
    visibility: visible;
  }
  .icon:hover {
    opacity: 1;
  }
</style>
