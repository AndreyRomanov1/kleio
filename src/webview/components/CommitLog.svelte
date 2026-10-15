<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { formatDate, formatFullDate, shortHash } from '../format';
  import { menu } from '../menu.svelte';
  import { pipelineIcons } from '../hostingView';
  import { commitMenu } from '../menus';
  import type { LogStore } from '../store.svelte';
  import { post } from '../vscode';
  import GraphCell from './GraphCell.svelte';
  import RefBadges from './RefBadges.svelte';
  import { t } from '../../shared/l10n';
  import { breaksGraph, isEmptyQuery } from '../../shared/model';

  interface Props {
    store: LogStore;
    authorWidth: number;
    dateWidth: number;
    onresize: (column: 'author' | 'date', width: number) => void;
  }

  let { store, authorWidth, dateWidth, onresize }: Props = $props();

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

  // Merge requests merged long ago are loaded as the log is scrolled down to their commits.
  $effect(() => {
    if (last === 0 || store.rowCount === 0) return;
    const lowest = store.commitAt(Math.min(last, store.rowCount) - 1);
    if (lowest) store.wantMergedBefore(lowest.authorDate);
    if (last >= store.rowCount - OVERSCAN * 4) store.wantMoreCommits();
  });

  $effect(() => {
    if (store.revealRequest === 0) return;
    const hash = [...store.selected][0];
    void tick().then(() => scrollIntoView(hash));
  });

  // Keeps the selected commit in view when the text filter changes, e.g. to see it in the full history
  // after clearing a search.
  $effect(() => {
    void store.filtered;
    const hash = untrack(() => [...store.selected][0]);
    void tick().then(() => scrollIntoView(hash));
  });

  function startResize(event: PointerEvent, column: 'author' | 'date'): void {
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = column === 'author' ? authorWidth : dateWidth;
    const move = (e: PointerEvent) =>
      onresize(column, Math.max(50, Math.min(400, startWidth - (e.clientX - startX))));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

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

<div class="log" style:--author-width="{authorWidth}px" style:--date-width="{dateWidth}px">
  <div class="header">
    <span>{t('Commit')}</span>
    <span class="resizable"
      ><span
        class="resize"
        role="separator"
        aria-label={t('Width of the author column')}
        onpointerdown={(e) => startResize(e, 'author')}
      ></span>{t('Author')}</span
    >
    <span class="resizable"
      ><span
        class="resize"
        role="separator"
        aria-label={t('Width of the date column')}
        onpointerdown={(e) => startResize(e, 'date')}
      ></span>{t('Date')}</span
    >
    <span>{t('Hash')}</span>
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
    aria-label={t('Commits')}
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
          ondblclick={() => post({ type: 'openCommitDiff', hash: commit.hash })}
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
              dotOnly={store.filtered !== undefined ||
                store.history !== undefined ||
                breaksGraph(store.query)}
            />
            {#if decorations || store.logMergeRequests[commit.hash]?.length}<RefBadges
                hash={commit.hash}
                {decorations}
                {store}
              />{/if}
            <span class="subject" title={commit.subject}>{commit.subject}</span>
          </span>
          <span class="author" title={commit.authorEmail}>{commit.authorName}</span>
          <span class="date" title={formatFullDate(commit.authorDate)}>{formatDate(commit.authorDate)}</span>
          <span class="hash"
            >{#if store.hosting?.pipelines[commit.hash]}{@const icon =
                pipelineIcons[store.hosting.pipelines[commit.hash]]}<i
                class="pipeline codicon codicon-{icon.icon} {icon.tone}"
                title={icon.label}
              ></i>{/if}{shortHash(commit.hash)}</span
          >
        </div>
      {/each}
    </div>
    {#if store.rowCount === 0 && !store.loading}
      <div class="empty">
        {store.filterText || !isEmptyQuery(store.query) ? t('Nothing found') : t('No commits')}
      </div>
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
  .header,
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--author-width) var(--date-width) 82px;
    column-gap: 8px;
    align-items: center;
    padding: 0 8px 0 4px;
  }
  /* After the base grid: narrow logs drop the hash, then the author column. */
  @container (max-width: 560px) {
    .header,
    .row {
      grid-template-columns: minmax(0, 1fr) var(--author-width) var(--date-width);
    }
    .header > :nth-child(4),
    .row > .hash {
      display: none;
    }
  }
  @container (max-width: 440px) {
    .header,
    .row {
      grid-template-columns: minmax(0, 1fr) var(--date-width);
    }
    .header > :nth-child(2),
    .row > .author {
      display: none;
    }
  }
  .header {
    flex: none;
    height: 22px;
    font-size: 0.9em;
    opacity: 0.7;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  }
  .resizable {
    position: relative;
  }
  .resize {
    position: absolute;
    left: -6px;
    top: 0;
    bottom: 0;
    width: 5px;
    cursor: col-resize;
  }
  .resize:hover {
    background: var(--vscode-sash-hoverBorder);
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
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.92em;
  }
  .pipeline {
    font-size: 13px !important;
  }
  .pipeline.ok {
    color: var(--vscode-charts-green);
  }
  .pipeline.bad {
    color: var(--vscode-charts-red);
  }
  .pipeline.run {
    color: var(--vscode-charts-blue);
  }
  .pipeline.idle {
    opacity: 0.6;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    opacity: 0.6;
  }
</style>
