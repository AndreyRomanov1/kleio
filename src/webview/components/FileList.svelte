<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { FileChange } from '../../shared/model';
  import type { ChangeSetView } from '../../shared/protocol';
  import { basename, dirname } from '../format';
  import { menu } from '../menu.svelte';
  import { fileMenu } from '../menus';
  import { buildTree, flatten, folderKeys, leavesOf, type FlatRow, type TreeFolder } from '../tree';
  import { post } from '../vscode';
  import { t } from '../../shared/l10n';

  interface Props {
    changeSet: ChangeSetView;
    view: 'tree' | 'list';
    groupByDirectory: boolean;
    /** Narrows the log to the commits changing a file; absent where there is no log to narrow. */
    onfilterpath?: (path: string) => void;
    /**
     * Keys of collapsed folders. Kept by the owner across change sets, so that a folder collapsed in one commit
     * stays collapsed in the next one; keys are folder paths.
     */
    collapsed?: ReadonlySet<string>;
  }

  let { changeSet, view, groupByDirectory, onfilterpath, collapsed = $bindable(new Set()) }: Props = $props();
  // The list is recreated for every change set, so only the initial focus matters.
  const focused = untrack(() => changeSet.focusIndex);
  /** Key of the row the keyboard works with: a file or a folder. */
  let active = $state<string | undefined>(
    focused === undefined ? undefined : `files:${untrack(() => changeSet.files[focused].path)}`,
  );
  let list: HTMLDivElement | undefined = $state();

  // The focused file (e.g. the traced file of a history view) is scrolled into view once the list renders.
  $effect(() => {
    if (changeSet.focusIndex === undefined || !list) return;
    list.querySelector('.row.focus')?.scrollIntoView({ block: 'nearest' });
  });

  interface Indexed {
    change: FileChange;
    index: number;
  }

  type Row = FlatRow<Indexed> | { header: string };

  const items = $derived(changeSet.files.map((change, index) => ({ change, index })));
  const tree = $derived(view === 'tree' ? buildTree(items, (i) => i.change.path, 'files') : []);

  const rows = $derived.by((): Row[] => {
    if (view === 'tree') return flatten(tree, collapsed);
    const sorted = [...items].sort((a, b) => a.change.path.localeCompare(b.change.path));
    if (!groupByDirectory) return sorted.map((item) => ({ node: leafOf(item), depth: 0 }));
    const result: Row[] = [];
    let directory: string | undefined;
    for (const item of sorted) {
      const dir = dirname(item.change.path);
      if (dir !== directory) {
        directory = dir;
        result.push({ header: dir || '/' });
      }
      result.push({ node: leafOf(item), depth: 1 });
    }
    return result;
  });

  function leafOf(item: Indexed) {
    return {
      kind: 'leaf' as const,
      key: `files:${item.change.path}`,
      label: basename(item.change.path),
      item,
    };
  }

  function open(index: number): void {
    post({ type: 'fileAction', action: 'openDiff', changeSetId: changeSet.id, index });
  }

  const nodeRows = $derived(rows.filter((r): r is FlatRow<Indexed> => !('header' in r)));
  const activeRow = $derived(nodeRows.find((r) => r.node.key === active));
  const selected = $derived(activeRow?.node.kind === 'leaf' ? activeRow.node.item.index : undefined);

  /** Collapses or expands a folder; `deep` does the same to every folder under it, as Alt+click in VS Code. */
  function toggle(folder: TreeFolder<Indexed>, deep = false): void {
    const collapse = !collapsed.has(folder.key);
    const keys = deep ? folderKeys([folder]) : [folder.key];
    const next = new Set(collapsed);
    for (const key of keys) {
      if (collapse) next.add(key);
      else next.delete(key);
    }
    collapsed = next;
  }

  /** Expands every folder of this change set; folders collapsed in other change sets stay so. */
  export function expandAll(): void {
    const keys = new Set(folderKeys(tree));
    collapsed = new Set([...collapsed].filter((key) => !keys.has(key)));
  }

  export function collapseAll(): void {
    collapsed = new Set([...collapsed, ...folderKeys(tree)]);
  }

  /** What a collapsed folder holds: the number of files and how many of each kind of change. */
  function summary(folder: TreeFolder<Indexed>): { count: number; statuses: [string, number][] } {
    const files = leavesOf(folder);
    const statuses = new Map<string, number>();
    for (const { change } of files) statuses.set(change.status, (statuses.get(change.status) ?? 0) + 1);
    return { count: files.length, statuses: [...statuses].sort(([a], [b]) => a.localeCompare(b)) };
  }

  async function activate(key: string | undefined): Promise<void> {
    if (key === undefined) return;
    active = key;
    await tick();
    list?.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  /** Keys of a tree as in VS Code: arrows move, → and ← open and close folders or go in and out of them. */
  function keydown(event: KeyboardEvent): void {
    const at = activeRow ? nodeRows.indexOf(activeRow) : -1;
    const node = activeRow?.node;
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        void activate(nodeRows[Math.min(at + 1, nodeRows.length - 1)]?.node.key);
        break;
      case 'ArrowUp':
        void activate(nodeRows[Math.max(at - 1, 0)]?.node.key);
        break;
      case 'Home':
        void activate(nodeRows[0]?.node.key);
        break;
      case 'End':
        void activate(nodeRows[nodeRows.length - 1]?.node.key);
        break;
      case 'ArrowRight':
        if (node?.kind !== 'folder') break;
        if (collapsed.has(node.key)) toggle(node, event.altKey);
        else void activate(nodeRows[at + 1]?.node.key);
        break;
      case 'ArrowLeft': {
        if (node?.kind === 'folder' && !collapsed.has(node.key)) {
          toggle(node, event.altKey);
          break;
        }
        const depth = activeRow?.depth ?? 0;
        const parent = nodeRows
          .slice(0, Math.max(at, 0))
          .reverse()
          .find((r) => r.depth < depth);
        void activate(parent?.node.key);
        break;
      }
      case 'Enter':
        if (node?.kind === 'folder') toggle(node, event.altKey);
        else if (selected !== undefined) open(selected);
        break;
      case 'F4':
        if (selected !== undefined)
          post({ type: 'fileAction', action: 'openCurrent', changeSetId: changeSet.id, index: selected });
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  }

  const statusTitle: Record<string, string> = {
    A: t('Added'),
    M: t('Modified'),
    D: t('Deleted'),
    R: t('Renamed'),
    C: t('Copied'),
    T: t('Type changed'),
    U: t('Conflict'),
  };
</script>

<div class="files" role="tree" tabindex="0" onkeydown={keydown} bind:this={list}>
  {#each rows as row, i ('header' in row ? `h:${row.header}:${i}` : row.node.key)}
    {#if 'header' in row}
      <div class="header" title={row.header}>{row.header}</div>
    {:else if row.node.kind === 'folder'}
      {@const folder = row.node}
      {@const closed = collapsed.has(folder.key)}
      <button
        class="row folder"
        class:selected={active === folder.key}
        style:padding-left="{6 + row.depth * 14}px"
        title={t('Alt+click: with all folders inside')}
        tabindex="-1"
        onclick={(e) => {
          active = folder.key;
          toggle(folder, e.altKey);
          list?.focus();
        }}
      >
        <i class="chevron codicon codicon-chevron-{closed ? 'right' : 'down'}"></i>
        <i class="codicon codicon-folder{closed ? '' : '-opened'}"></i><span class="name">{folder.label}</span
        >
        {#if closed}
          {@const { count, statuses } = summary(folder)}
          <span class="summary">
            <span class="count">{count}</span>
            {#each statuses as [status, n] (status)}
              <span class="dot s{status}" title="{statusTitle[status] ?? status}: {n}"></span>
            {/each}
          </span>
        {/if}
      </button>
    {:else}
      {@const { change, index } = row.node.item}
      <div
        class="row file"
        class:selected={active === row.node.key}
        class:focus={changeSet.focusIndex === index}
        style:padding-left="{18 + row.depth * 14}px"
        role="treeitem"
        aria-selected={active === row.node.key}
        tabindex="-1"
        onclick={() => (active = row.node.key)}
        onkeydown={(e) => e.key === ' ' && (active = row.node.key)}
        ondblclick={() => open(index)}
        oncontextmenu={(e) => {
          active = row.node.key;
          menu.show(e, fileMenu(changeSet, index, onfilterpath));
        }}
      >
        <span class="status s{change.status}" title={statusTitle[change.status]}>{change.status}</span>
        <span class="name s{change.status}">{row.node.label}</span>
        {#if view === 'list' && !groupByDirectory}<span class="dir">{dirname(change.path)}</span>{/if}
        {#if change.oldPath}<span class="dir" title={change.oldPath}>← {basename(change.oldPath)}</span>{/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .files {
    overflow: auto;
    flex: 1;
    min-height: 0;
    outline: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 22px;
    padding-right: 6px;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    white-space: nowrap;
    cursor: default;
  }
  .row:focus {
    outline: none;
  }
  .row:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .row.focus .name {
    font-weight: 600;
  }
  .row.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
  }
  .files:focus-within .row.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .header {
    padding: 4px 6px 0;
    font-size: 0.85em;
    opacity: 0.7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-left: 2px;
  }
  .summary .count {
    opacity: 0.6;
    font-size: 0.9em;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .chevron {
    width: 12px;
    opacity: 0.7;
  }
  .status {
    flex: none;
    width: 12px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.85em;
    font-weight: 600;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dir {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.6;
    font-size: 0.9em;
  }
  .sA {
    color: var(--vscode-gitDecoration-addedResourceForeground);
  }
  .sM,
  .sT {
    color: var(--vscode-gitDecoration-modifiedResourceForeground);
  }
  .sD {
    color: var(--vscode-gitDecoration-deletedResourceForeground);
  }
  .sR,
  .sC {
    color: var(--vscode-gitDecoration-renamedResourceForeground);
  }
  .sU {
    color: var(--vscode-gitDecoration-conflictingResourceForeground);
  }
  .name.sD {
    text-decoration: line-through;
  }
</style>
