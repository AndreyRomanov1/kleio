<script lang="ts">
  import type { FileChange } from '../../shared/model';
  import type { ChangeSetView } from '../../shared/protocol';
  import { basename, dirname } from '../format';
  import { menu } from '../menu.svelte';
  import { fileMenu } from '../menus';
  import { buildTree, flatten, type FlatRow } from '../tree';
  import { post } from '../vscode';

  interface Props {
    changeSet: ChangeSetView;
    view: 'tree' | 'list';
    groupByDirectory: boolean;
  }

  let { changeSet, view, groupByDirectory }: Props = $props();
  let collapsed = $state(new Set<string>());
  let selected = $state<number | undefined>(undefined);

  interface Indexed {
    change: FileChange;
    index: number;
  }

  type Row = FlatRow<Indexed> | { header: string };

  const rows = $derived.by((): Row[] => {
    const items = changeSet.files.map((change, index) => ({ change, index }));
    if (view === 'tree')
      return flatten(
        buildTree(items, (i) => i.change.path, 'files'),
        collapsed,
      );
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

  function toggle(key: string): void {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsed = next;
  }

  function keydown(event: KeyboardEvent): void {
    if (selected === undefined) return;
    if (event.key === 'Enter') open(selected);
    if (event.key === 'F4')
      post({ type: 'fileAction', action: 'openCurrent', changeSetId: changeSet.id, index: selected });
  }

  const statusTitle: Record<string, string> = {
    A: 'Добавлен',
    M: 'Изменён',
    D: 'Удалён',
    R: 'Переименован',
    C: 'Скопирован',
    T: 'Сменился тип',
    U: 'Конфликт',
  };
</script>

<div class="files" role="tree" tabindex="0" onkeydown={keydown}>
  {#each rows as row, i ('header' in row ? `h:${row.header}:${i}` : row.node.key)}
    {#if 'header' in row}
      <div class="header" title={row.header}>{row.header}</div>
    {:else if row.node.kind === 'folder'}
      {@const key = row.node.key}
      <button class="row folder" style:padding-left="{6 + row.depth * 14}px" onclick={() => toggle(key)}>
        <i class="chevron codicon codicon-chevron-{collapsed.has(key) ? 'right' : 'down'}"></i>
        <i class="codicon codicon-folder"></i>{row.node.label}
      </button>
    {:else}
      {@const { change, index } = row.node.item}
      <div
        class="row file"
        class:selected={selected === index}
        style:padding-left="{18 + row.depth * 14}px"
        role="treeitem"
        aria-selected={selected === index}
        tabindex="-1"
        onclick={() => (selected = index)}
        onkeydown={(e) => e.key === ' ' && (selected = index)}
        ondblclick={() => open(index)}
        oncontextmenu={(e) => {
          selected = index;
          menu.show(e, fileMenu(changeSet, index));
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
  .row:hover {
    background: var(--vscode-list-hoverBackground);
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
