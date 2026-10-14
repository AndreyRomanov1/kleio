<script lang="ts">
  import { tick } from 'svelte';
  import { formatDate, formatFullDate, shortHash } from '../format';
  import { menu } from '../menu.svelte';
  import { commitMenu } from '../menus';
  import type { LogStore } from '../store.svelte';
  import GraphCell from './GraphCell.svelte';
  import RefBadges from './RefBadges.svelte';

  interface Props {
    store: LogStore;
  }

  let { store }: Props = $props();

  const ROW_HEIGHT = 24;
  const OVERSCAN = 12;
  const MAX_LANES = 24;

  let viewport: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let viewportHeight = $state(400);

  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  const last = $derived(
    Math.min(store.rowCount, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN),
  );
  const visible = $derived(Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i));
  const headHash = $derived(store.snapshot?.head.hash);
  // The graph column fits the lanes on screen, so a wide stretch elsewhere in history wastes no space here.
  const lanes = $derived.by(() => {
    let width = 1;
    for (const row of visible)
      width = Math.max(width, store.layout.rows[store.commitIndexAt(row)]?.width ?? 1);
    return Math.min(width, MAX_LANES);
  });

  $effect(() => {
    if (store.revealRequest === 0) return;
    const hash = [...store.selected][0];
    void tick().then(() => scrollIntoView(hash));
  });

  function scrollIntoView(hash: string | undefined): void {
    if (!viewport || !hash) return;
    const row = store.rowOf(hash);
    if (row === undefined) return;
    const top = row * ROW_HEIGHT;
    if (top < viewport.scrollTop || top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = Math.max(0, top - viewport.clientHeight / 3);
    }
  }

  function keydown(event: KeyboardEvent): void {
    const page = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);
    const moves: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: page,
      PageUp: -page,
      Home: -store.rowCount,
      End: store.rowCount,
    };
    const delta = moves[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    store.step(delta, event.shiftKey);
  }
</script>

<div class="log">
  <div class="header">
    <span>Коммит</span>
    <span>Автор</span>
    <span>Дата</span>
    <span>Хэш</span>
  </div>
  <div
    class="viewport"
    bind:this={viewport}
    bind:clientHeight={viewportHeight}
    onscroll={() => (scrollTop = viewport?.scrollTop ?? 0)}
    onkeydown={keydown}
    tabindex="0"
    role="listbox"
    aria-multiselectable="true"
    aria-label="Коммиты"
  >
    <div class="spacer" style:height="{store.rowCount * ROW_HEIGHT}px">
      {#each visible as row (row)}
        {@const index = store.commitIndexAt(row)}
        {@const commit = store.snapshot!.commits[index]}
        {@const decorations = store.decorations.get(commit.hash)}
        <div
          class="row"
          class:selected={store.selected.has(commit.hash)}
          class:head={commit.hash === headHash}
          style:top="{row * ROW_HEIGHT}px"
          style:height="{ROW_HEIGHT}px"
          role="option"
          aria-selected={store.selected.has(commit.hash)}
          tabindex="-1"
          onmousedown={(e) => {
            if (e.button !== 0) return;
            store.click(commit.hash, e.ctrlKey || e.metaKey, e.shiftKey);
          }}
          oncontextmenu={(e) => {
            if (!store.selected.has(commit.hash)) store.click(commit.hash, false, false);
            menu.show(e, commitMenu(commit, store));
          }}
        >
          <span class="subject-cell">
            <GraphCell
              row={store.layout.rows[index]}
              {lanes}
              height={ROW_HEIGHT}
              isHead={commit.hash === headHash}
              isMerge={commit.parents.length > 1}
              dotOnly={store.filtered !== undefined}
            />
            {#if decorations}<RefBadges {decorations} {store} />{/if}
            <span class="subject" title={commit.subject}>{commit.subject}</span>
          </span>
          <span class="author" title={commit.authorEmail}>{commit.authorName}</span>
          <span class="date" title={formatFullDate(commit.authorDate)}>{formatDate(commit.authorDate)}</span>
          <span class="hash">{shortHash(commit.hash)}</span>
        </div>
      {/each}
    </div>
    {#if store.rowCount === 0 && !store.loading}
      <div class="empty">{store.filterText ? 'Ничего не найдено' : 'Нет коммитов'}</div>
    {/if}
  </div>
</div>

<style>
  .log {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    flex: 1;
    container-type: inline-size;
  }
  @container (max-width: 720px) {
    .header,
    .row {
      grid-template-columns: minmax(0, 1fr) 110px 120px;
    }
    .header > :nth-child(4),
    .row > .hash {
      display: none;
    }
  }
  @container (max-width: 520px) {
    .header,
    .row {
      grid-template-columns: minmax(0, 1fr) 120px;
    }
    .header > :nth-child(2),
    .row > .author {
      display: none;
    }
  }
  .header,
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--author-width, 150px) var(--date-width, 130px) 72px;
    column-gap: 10px;
    align-items: center;
    padding: 0 8px 0 4px;
  }
  .header {
    flex: none;
    height: 22px;
    font-size: 0.9em;
    opacity: 0.7;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  }
  .viewport {
    position: relative;
    flex: 1;
    overflow: auto;
    outline: none;
  }
  .spacer {
    position: relative;
    min-width: 100%;
  }
  .row {
    position: absolute;
    left: 0;
    right: 0;
    cursor: default;
    white-space: nowrap;
  }
  .row:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .row.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
    color: var(--vscode-list-inactiveSelectionForeground);
  }
  .viewport:focus-within .row.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .row.head .subject {
    font-weight: 600;
  }
  .subject-cell {
    display: flex;
    align-items: center;
    min-width: 0;
    overflow: hidden;
  }
  .subject {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-left: 4px;
  }
  .author,
  .date,
  .hash {
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.8;
  }
  .hash {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.92em;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    opacity: 0.6;
  }
</style>
