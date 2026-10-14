<script lang="ts">
  import type { HostMessage } from '../shared/protocol';
  import BranchPanel from './components/BranchPanel.svelte';
  import CommitLog from './components/CommitLog.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import Details from './components/Details.svelte';
  import Splitter from './components/Splitter.svelte';
  import { LogStore } from './store.svelte';
  import { loadUiState, post, saveUiState, type UiState } from './vscode';

  const store = new LogStore();
  let ui = $state<UiState>(loadUiState());
  let width = $state(1200);
  let height = $state(600);

  // Details move under the log when the log itself would get too narrow next to them.
  const narrow = $derived(width - (ui.showBranches ? ui.branchWidth : 0) - ui.detailsWidth < 600);
  const collapsed = $derived(new Set(ui.collapsed));

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
      if (names.has(`origin/${main}`)) revisions.push(`origin/${main}`);
      else if (names.has(main)) revisions.push(main);
    }
    post({ type: 'setFocus', revisions: [...new Set(revisions)] });
  }

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
</script>

<svelte:window
  onkeydown={(e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      document.getElementById('grove-filter')?.focus();
    }
  }}
/>

<div class="app" bind:clientWidth={width} bind:clientHeight={height}>
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
    <button
      class="tool"
      class:on={ui.showBranches}
      title="Панель веток"
      onclick={() => (ui.showBranches = !ui.showBranches)}>Ветки</button
    >
    <input
      id="grove-filter"
      class="filter"
      placeholder="Текст, автор или хэш (Ctrl+F)"
      bind:value={store.filterText}
      spellcheck="false"
    />
    {#if store.focus.length}
      <div class="focus" title="Лог показывает только историю этих веток">
        <span class="focus-label">Фокус:</span>
        {#each store.focus as revision (revision)}
          <span class="chip">
            {revision}
            <button
              title="Убрать из фокуса"
              onclick={() => post({ type: 'setFocus', revisions: store.focus.filter((r) => r !== revision) })}
              >×</button
            >
          </span>
        {/each}
        <button class="tool" onclick={() => post({ type: 'setFocus', revisions: [] })}>Все ветки</button>
      </div>
    {:else}
      <button class="tool" title="Показать только текущую ветку, её origin и master" onclick={focusCurrent}
        >Только текущая</button
      >
    {/if}
    <span class="spacer"></span>
    {#if store.loading}<i class="loading codicon codicon-loading codicon-modifier-spin"></i>{/if}
    <button class="tool" title="git fetch --all --prune" onclick={() => post({ type: 'fetch' })}
      ><i class="codicon codicon-cloud-download"></i> Fetch</button
    >
    <button class="tool icon" title="Обновить" aria-label="Обновить" onclick={() => post({ type: 'refresh' })}
      ><i class="codicon codicon-refresh"></i></button
    >
  </div>

  {#if store.noRepository}
    <div class="empty">В открытых папках нет git-репозитория.</div>
  {:else}
    <div class="main" class:narrow>
      {#if ui.showBranches}
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
        <Splitter ondrag={(d) => (ui.detailsWidth = clamp(ui.detailsWidth - d, 220, width * 0.6))} />
        <div class="details-side" style:width="{ui.detailsWidth}px">
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
