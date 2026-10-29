<script lang="ts">
  import type { HostMessage } from '../shared/protocol';
  import BranchPanel from './components/BranchPanel.svelte';
  import CommitLog from './components/CommitLog.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import MergeRequestCard from './components/MergeRequestCard.svelte';
  import OperationBanner from './components/OperationBanner.svelte';
  import Details from './components/Details.svelte';
  import LogFilters from './components/LogFilters.svelte';
  import Splitter from './components/Splitter.svelte';
  import { LogStore } from './store.svelte';
  import { loadUiState, post, saveUiState, type UiState } from './vscode';
  import { t } from '../shared/l10n';
  import { isEmptyQuery } from '../shared/model';

  const store = new LogStore();
  let ui = $state<UiState>(loadUiState());
  let width = $state(1200);
  let height = $state(600);

  /**
   * The size of the view for the layout. A hidden tab (e.g. the log tab behind a diff opened in its place)
   * measures 0×0; taking that for a narrow view would move the details under the log and back, recreating
   * them and losing what they showed.
   */
  function measure(node: HTMLElement, onsize: (width: number, height: number) => void) {
    const observer = new ResizeObserver(() => {
      if (node.clientWidth > 0 && node.clientHeight > 0) onsize(node.clientWidth, node.clientHeight);
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  // Details move under the log when the log itself would get too narrow next to them.
  const showBranches = $derived(ui.showBranches && !store.history);
  // Details never squeeze the log below a readable width: a wide details panel shrinks instead of moving the
  // details under the log; in "auto" they move down only when the view itself is narrow.
  const sideSpace = $derived(width - (showBranches ? ui.branchWidth : 0));
  const detailsSide = $derived(Math.max(220, Math.min(ui.detailsWidth, sideSpace - 600)));
  const narrow = $derived(
    ui.detailsPosition === 'bottom' || (ui.detailsPosition === 'auto' && sideSpace - 600 < 220),
  );
  const positions = {
    auto: { next: 'right', icon: 'layout', title: t('Details: by the window width') },
    right: { next: 'bottom', icon: 'layout-sidebar-right', title: t('Details: on the right') },
    bottom: { next: 'auto', icon: 'layout-panel', title: t('Details: at the bottom') },
  } as const;
  const collapsed = $derived(new Set(ui.collapsed));
  let filtersOpen = $state(false);
  const queryCount = $derived(
    Object.entries(store.query).filter(([key, value]) => key !== 'changesRegex' && value?.length).length,
  );
  // A filter set from a menu shows the bar, so that it is clear why commits are missing.
  $effect(() => {
    if (!isEmptyQuery(store.query)) filtersOpen = true;
  });

  $effect(() => {
    saveUiState($state.snapshot(ui));
  });

  $effect(() => {
    const listener = (event: MessageEvent<HostMessage>) => store.handle(event.data);
    window.addEventListener('message', listener);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  });

  function toggleCollapsed(key: string): void {
    ui.collapsed = ui.collapsed.includes(key)
      ? ui.collapsed.filter((k) => k !== key)
      : [...ui.collapsed, key];
  }

  function focusCurrent(): void {
    const snapshot = store.snapshot;
    if (!snapshot) return;
    const names = new Set(snapshot.refs.map((r) => r.name));
    const revisions = [snapshot.head.branch ?? snapshot.head.hash ?? 'HEAD'];
    const current = snapshot.refs.find((r) => r.kind === 'head' && r.name === snapshot.head.branch);
    if (current?.upstream) revisions.push(current.upstream.replace('refs/remotes/', ''));
    for (const main of ['master', 'main']) {
      if (names.has(main)) revisions.push(main);
      if (names.has(`origin/${main}`)) revisions.push(`origin/${main}`);
    }
    post({ type: 'setFocus', revisions: [...new Set(revisions)] });
  }

  /**
   * Speed search as in Rider: typing in the branch tree goes to the branch search, typing anywhere else to
   * the commit filter. Focus moves before the key is handled, so the typed character lands in the field.
   */
  function speedSearch(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('input, select, textarea')) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 || event.key === ' ') return;
    const field = target.closest('.branches') ? 'kleio-branch-search' : 'kleio-filter';
    document.getElementById(field)?.focus();
  }

  function clearOnEscape(event: KeyboardEvent, clear: () => boolean): void {
    if (event.key !== 'Escape') return;
    if (!clear()) (event.currentTarget as HTMLElement).blur();
  }

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
</script>

<svelte:window
  onkeydown={(e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      document.getElementById('kleio-filter')?.focus();
      return;
    }
    speedSearch(e);
  }}
/>

<div
  class="app"
  use:measure={(w, h) => {
    width = w;
    height = h;
  }}
>
  <div class="toolbar">
    {#if store.repositories.length > 1}
      <select
        value={store.snapshot?.root}
        onchange={(e) =>
          post({ type: 'selectRepository', root: (e.currentTarget as HTMLSelectElement).value })}
      >
        {#each store.repositories as repository (repository.root)}
          <option value={repository.root}>{repository.name}</option>
        {/each}
      </select>
    {/if}
    {#if store.history}
      <span class="history-title"><i class="codicon codicon-history"></i> {store.history}</span>
    {:else}
      <button
        class="tool"
        class:on={ui.showBranches}
        title={t('Branches panel')}
        onclick={() => (ui.showBranches = !ui.showBranches)}>{t('Branches')}</button
      >
    {/if}
    <input
      id="kleio-filter"
      class="filter"
      placeholder={t('Text, author or hash (Ctrl+F)')}
      bind:value={store.filterText}
      spellcheck="false"
      onkeydown={(e) =>
        clearOnEscape(e, () => {
          const had = store.filterText !== '';
          store.filterText = '';
          return had;
        })}
    />
    {#if store.history}
      <span class="hint"
        >{t('the diff of the selected commit is on the right; arrows move through the history')}</span
      >
    {:else if store.focus.length}
      <div class="focus" title={t('The log shows only the history of these branches')}>
        <span class="focus-label">{t('Focus:')}</span>
        {#each store.focus as revision (revision)}
          <span class="chip">
            {revision}
            <button
              title={t('Remove from focus')}
              onclick={() => post({ type: 'setFocus', revisions: store.focus.filter((r) => r !== revision) })}
              >×</button
            >
          </span>
        {/each}
        <button class="tool" onclick={() => post({ type: 'setFocus', revisions: [] })}
          >{t('All branches')}</button
        >
      </div>
    {:else}
      <button
        class="tool"
        title={t('Show only the current branch, its remote branch and the default branch')}
        onclick={focusCurrent}>{t('Current only')}</button
      >
    {/if}
    {#if !store.history}
      <button
        class="tool"
        class:on={filtersOpen || queryCount > 0}
        title={t('Filter by author, date, paths and changed text')}
        onclick={() => (filtersOpen = !filtersOpen)}
        ><i class="codicon codicon-filter"></i>
        {queryCount ? t('Filters: {0}', queryCount) : t('Filters')}</button
      >
    {/if}
    <span class="spacer"></span>
    {#if store.loading}<i class="loading codicon codicon-loading codicon-modifier-spin"></i>{/if}
    {#if (store.hosting?.remoteCount ?? 0) > 1 && !store.history}
      <button
        class="tool"
        title={t(
          'Merge requests and pipelines come from remote {0}; click to choose another',
          store.hosting?.remote ?? '',
        )}
        onclick={() => post({ type: 'selectHostingRemote' })}
        ><i class="codicon codicon-remote"></i>
        {store.hosting?.name
          ? `${store.hosting.name} · ${store.hosting.remote}`
          : store.hosting?.remote}</button
      >
    {/if}
    {#if store.hosting?.api === 'needsAuth' && !store.history}
      <button
        class="tool"
        title={t('Give Kleio access to {0}: merge request states, pipelines', store.hosting.name ?? 'GitLab')}
        onclick={() => post({ type: 'connectHosting' })}
        ><i class="codicon codicon-plug"></i> {t('Connect {0}', store.hosting.name ?? 'GitLab')}</button
      >
    {/if}
    {#if !store.history}
      <button class="tool" title="git fetch --all --prune" onclick={() => post({ type: 'fetch' })}
        ><i class="codicon codicon-cloud-download"></i> Fetch</button
      >
      <button
        class="tool"
        title={t('Update project: fetch and pull the current branch from its upstream')}
        onclick={() => post({ type: 'updateProject' })}
        ><i class="codicon codicon-repo-pull"></i> {t('Update')}</button
      >
      <button class="tool" title="Push…" onclick={() => post({ type: 'push' })}
        ><i class="codicon codicon-repo-push"></i> Push</button
      >
    {/if}
    <button
      class="tool icon"
      title={t('{0}; click to change', positions[ui.detailsPosition].title)}
      aria-label={positions[ui.detailsPosition].title}
      onclick={() => (ui.detailsPosition = positions[ui.detailsPosition].next)}
      ><i class="codicon codicon-{positions[ui.detailsPosition].icon}"></i></button
    >
    <button
      class="tool icon"
      title={t('Refresh')}
      aria-label={t('Refresh')}
      onclick={() => post({ type: 'refresh' })}><i class="codicon codicon-refresh"></i></button
    >
  </div>

  {#if filtersOpen && !store.history}
    <LogFilters {store} onclose={() => (filtersOpen = false)} />
  {/if}
  {#if store.snapshot?.operation && !store.history}
    <OperationBanner
      operation={store.snapshot.operation}
      current={store.snapshot.head.branch}
      describe={(hash) => {
        const refs = store.decorations.get(hash)?.refs ?? [];
        return (refs.find((r) => r.kind === 'head') ?? refs.find((r) => r.kind === 'remote') ?? refs[0])
          ?.name;
      }}
      onaction={(action) => post({ type: 'operation', action })}
    />
  {/if}
  {#if store.noRepository}
    <div class="empty">{t('There is no git repository in the open folders.')}</div>
  {:else}
    <div class="main" class:narrow>
      {#if showBranches}
        <div class="branches" style:width="{ui.branchWidth}px">
          <BranchPanel {store} {collapsed} ontoggle={toggleCollapsed} />
        </div>
        <Splitter ondrag={(d) => (ui.branchWidth = clamp(ui.branchWidth + d, 140, width / 2))} />
      {/if}
      <div class="center">
        <div class="log-area">
          <CommitLog
            {store}
            authorWidth={ui.authorWidth}
            dateWidth={ui.dateWidth}
            onresize={(column, value) => {
              if (column === 'author') ui.authorWidth = value;
              else ui.dateWidth = value;
            }}
          />
        </div>
        {#if narrow}
          <Splitter
            vertical
            ondrag={(d) => (ui.detailsHeight = clamp(ui.detailsHeight - d, 100, height - 120))}
          />
          <div class="details-bottom" style:height="{Math.min(ui.detailsHeight, height * 0.5)}px">
            <Details
              {store}
              fileView={ui.fileView}
              groupByDirectory={ui.groupByDirectory}
              onview={(v) => (ui.fileView = v)}
              ongroup={(g) => (ui.groupByDirectory = g)}
            />
          </div>
        {/if}
      </div>
      {#if !narrow}
        <Splitter
          ondrag={(d) => (ui.detailsWidth = clamp(detailsSide - d, 220, Math.max(220, sideSpace - 300)))}
        />
        <div
          class="details-side"
          style:width="{ui.detailsPosition === 'right'
            ? Math.max(220, Math.min(ui.detailsWidth, sideSpace - 300))
            : detailsSide}px"
        >
          <Details
            {store}
            fileView={ui.fileView}
            groupByDirectory={ui.groupByDirectory}
            onview={(v) => (ui.fileView = v)}
            ongroup={(g) => (ui.groupByDirectory = g)}
          />
        </div>
      {/if}
    </div>
  {/if}
  <MergeRequestCard {store} />
  <ContextMenu />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .toolbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
    min-width: 0;
    overflow: hidden;
  }
  .filter {
    width: 260px;
    min-width: 120px;
    flex-shrink: 1;
  }
  .focus {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
  }
  .focus-label {
    opacity: 0.7;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 2px 0 6px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    white-space: nowrap;
  }
  .chip button {
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    padding: 0 3px;
  }
  .history-title {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
    white-space: nowrap;
  }
  .hint {
    opacity: 0.6;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .loading {
    opacity: 0.6;
    font-size: 0.9em;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    padding: 2px 8px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .tool:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .tool.on {
    border-color: var(--vscode-focusBorder);
  }
  .main {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .branches,
  .details-side {
    flex: none;
    min-height: 0;
    overflow: hidden;
  }
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .log-area {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .details-bottom {
    flex: none;
    min-height: 0;
    overflow: hidden;
  }
  .empty {
    margin: auto;
    opacity: 0.6;
  }
</style>
