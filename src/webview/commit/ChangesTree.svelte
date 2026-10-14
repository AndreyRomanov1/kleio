<script lang="ts">
  import type { CommitFile } from '../../shared/commitProtocol';
  import { basename, dirname } from '../format';
  import { menu } from '../menu.svelte';
  import { buildTree, flatten, type TreeNode } from '../tree';
  import { postCommit } from '../vscode';
  import Check from './Check.svelte';
  import type { CommitStore } from './commitStore.svelte';

  interface Props {
    store: CommitStore;
    collapsed: ReadonlySet<string>;
    ontoggle: (key: string) => void;
  }

  let { store, collapsed, ontoggle }: Props = $props();

  interface Section {
    key: string;
    title: string;
    files: CommitFile[];
    nodes: TreeNode<CommitFile>[];
  }

  const sections = $derived.by((): Section[] => {
    const make = (key: string, title: string, files: CommitFile[]): Section => ({
      key,
      title,
      files,
      nodes: store.flat
        ? [...files]
            .sort((a, b) => basename(a.path).localeCompare(basename(b.path)))
            .map((f) => ({
              kind: 'leaf' as const,
              key: `${key}:${f.path}`,
              label: basename(f.path),
              item: f,
            }))
        : buildTree(files, (f) => f.path, key),
    });
    const changes = store.files.filter((f) => f.kind !== 'untracked');
    const untracked = store.files.filter((f) => f.kind === 'untracked');
    return [
      make('section:changes', 'Изменения', changes),
      ...(untracked.length ? [make('section:untracked', 'Неотслеживаемые файлы', untracked)] : []),
    ];
  });

  function leaves(node: TreeNode<CommitFile>): CommitFile[] {
    return node.kind === 'leaf' ? [node.item] : node.children.flatMap(leaves);
  }

  function stateOf(files: CommitFile[]): 'all' | 'some' | 'none' {
    const states = files.map((f) => store.fileState(f.path));
    if (states.every((s) => s === 'none')) return 'none';
    return states.every((s) => s === 'all') ? 'all' : 'some';
  }

  /** Only modified files are split into parts; a new, deleted or renamed file is committed whole. */
  const splittable = (file: CommitFile) => file.kind === 'tracked' && file.status === 'M';

  function fileMenu(event: MouseEvent, file: CommitFile): void {
    if (!store.selected.has(file.path)) store.select(file.path, false);
    const targets = store.targets;
    menu.show(event, [
      {
        label: 'Показать diff',
        hint: 'двойной клик',
        icon: 'diff',
        run: () => postCommit({ type: 'openDiff', path: file.path }),
      },
      {
        label: 'Открыть файл',
        icon: 'go-to-file',
        run: () => postCommit({ type: 'openFile', path: file.path }),
      },
      'separator',
      {
        label: targets.length > 1 ? `Откатить (${targets.length})…` : 'Откатить…',
        icon: 'discard',
        run: () => postCommit({ type: 'rollback', paths: targets }),
      },
    ]);
  }

  const statusTitle: Record<string, string> = {
    A: 'Добавлен',
    M: 'Изменён',
    D: 'Удалён',
    R: 'Перемещён',
    C: 'Скопирован',
    T: 'Сменился тип',
    U: 'Конфликт',
    '?': 'Не под версионным контролем',
  };
</script>

<div class="tree" role="tree">
  {#each sections as section (section.key)}
    {@const open = !collapsed.has(section.key)}
    <div class="row section" role="treeitem" aria-selected="false" aria-expanded={open} tabindex="-1">
      <button class="chevron" aria-label="Свернуть" onclick={() => ontoggle(section.key)}
        ><i class="codicon codicon-chevron-{open ? 'down' : 'right'}"></i></button
      >
      <Check
        state={stateOf(section.files)}
        label={section.title}
        onchange={(v) =>
          store.setChecked(
            section.files.map((f) => f.path),
            v,
          )}
      />
      <span class="label">{section.title}</span>
      <span class="count">{section.files.length}</span>
    </div>
    {#if open}
      {#each flatten(section.nodes, collapsed) as { node, depth } (node.key)}
        {#if node.kind === 'folder'}
          {@const files = leaves(node)}
          <div
            class="row folder"
            style:padding-left="{18 + depth * 14}px"
            role="treeitem"
            aria-selected="false"
            tabindex="-1"
            onclick={() => ontoggle(node.key)}
            onkeydown={(e) => e.key === 'Enter' && ontoggle(node.key)}
          >
            <i class="chevron-icon codicon codicon-chevron-{collapsed.has(node.key) ? 'right' : 'down'}"></i>
            <Check
              state={stateOf(files)}
              label={node.label}
              onchange={(v) =>
                store.setChecked(
                  files.map((f) => f.path),
                  v,
                )}
            />
            <i class="codicon codicon-folder"></i>
            <span class="label">{node.label}</span>
            <span class="count">{files.length}</span>
          </div>
        {:else}
          {@const file = node.item}
          <div
            class="row file"
            class:selected={store.selected.has(file.path)}
            style:padding-left="{14 + depth * 14}px"
            role="treeitem"
            aria-selected={store.selected.has(file.path)}
            tabindex="-1"
            onclick={(e) => store.select(file.path, e.ctrlKey || e.metaKey)}
            ondblclick={() => postCommit({ type: 'openDiff', path: file.path })}
            onkeydown={(e) => {
              if (e.key === 'Enter') postCommit({ type: 'openDiff', path: file.path });
              if (e.key === ' ') {
                e.preventDefault();
                store.setChecked([file.path], !store.checked.has(file.path));
              }
            }}
            oncontextmenu={(e) => fileMenu(e, file)}
          >
            {#if splittable(file)}
              <button
                class="chevron"
                aria-label={store.expanded.has(file.path) ? 'Скрыть куски' : 'Показать куски'}
                title="Куски изменений: коммитить часть файла"
                onclick={(e) => {
                  e.stopPropagation();
                  store.toggleExpanded(file.path);
                }}
                ondblclick={(e) => e.stopPropagation()}
                ><i class="codicon codicon-chevron-{store.expanded.has(file.path) ? 'down' : 'right'}"
                ></i></button
              >
            {:else}
              <span class="chevron-space"></span>
            {/if}
            <Check
              state={store.fileState(file.path)}
              label={file.path}
              onchange={(v) => store.setChecked([file.path], v)}
            />
            <span class="name s{file.status === '?' ? 'Q' : file.status}" title={statusTitle[file.status]}
              >{node.label}</span
            >
            {#if store.flat}<span class="dir">{dirname(file.path)}</span>{/if}
            {#if file.oldPath}<span class="dir" title={file.oldPath}>← {file.oldPath}</span>{/if}
          </div>
          {#if store.expanded.has(file.path)}
            {@const hunks = store.hunks.get(file.path)}
            {#if !hunks}
              <div class="row hunk muted" style:padding-left="{52 + depth * 14}px">Загрузка…</div>
            {:else if hunks.length === 0}
              <div class="row hunk muted" style:padding-left="{52 + depth * 14}px">Не делится на куски</div>
            {/if}
            {#each hunks ?? [] as hunk (hunk.key)}
              <div
                class="row hunk"
                style:padding-left="{52 + depth * 14}px"
                role="treeitem"
                aria-selected="false"
                tabindex="-1"
                title={hunk.preview.join('\n')}
                ondblclick={() => postCommit({ type: 'openDiff', path: file.path, line: hunk.line })}
                onkeydown={(e) => {
                  if (e.key === 'Enter') postCommit({ type: 'openDiff', path: file.path, line: hunk.line });
                  if (e.key === ' ') {
                    e.preventDefault();
                    store.setHunk(file.path, hunk.key, !store.hunkChecked(file.path, hunk.key));
                  }
                }}
              >
                <Check
                  state={store.hunkChecked(file.path, hunk.key) ? 'all' : 'none'}
                  label="Строка {hunk.line}"
                  onchange={(v) => store.setHunk(file.path, hunk.key, v)}
                />
                <span class="where">стр. {hunk.line}</span>
                {#if hunk.added}<span class="added">+{hunk.added}</span>{/if}
                {#if hunk.removed}<span class="removed">−{hunk.removed}</span>{/if}
                <code class="preview"
                  >{(hunk.preview.find((l) => l.startsWith('+')) ?? hunk.preview[0])?.slice(1).trim()}</code
                >
              </div>
            {/each}
          {/if}
        {/if}
      {/each}
    {/if}
  {/each}
  {#if store.loaded && store.files.length === 0}
    <div class="empty">Нет изменений</div>
  {/if}
</div>

<style>
  .tree {
    flex: 1;
    min-height: 0;
    overflow: auto;
    outline: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding-right: 8px;
    white-space: nowrap;
    cursor: default;
  }
  .row:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .row.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
  }
  .tree:focus-within .row.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .section {
    padding-left: 2px;
    font-weight: 600;
  }
  .chevron {
    border: none;
    background: none;
    color: inherit;
    padding: 0;
    cursor: pointer;
    display: inline-flex;
  }
  .chevron-icon {
    opacity: 0.8;
  }
  .label,
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count,
  .dir {
    opacity: 0.6;
    font-size: 0.9em;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
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
    text-decoration: line-through;
  }
  .sR,
  .sC {
    color: var(--vscode-gitDecoration-renamedResourceForeground);
  }
  .sU {
    color: var(--vscode-gitDecoration-conflictingResourceForeground);
  }
  .sQ {
    color: var(--vscode-gitDecoration-untrackedResourceForeground);
  }
  .chevron-space {
    display: inline-block;
    width: 16px;
    flex: none;
  }
  .hunk {
    font-size: 0.95em;
  }
  .hunk.muted {
    opacity: 0.6;
  }
  .where {
    opacity: 0.8;
  }
  .added {
    color: var(--vscode-gitDecoration-addedResourceForeground);
  }
  .removed {
    color: var(--vscode-gitDecoration-deletedResourceForeground);
  }
  .preview {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.7;
    font-family: var(--vscode-editor-font-family);
  }
  .empty {
    padding: 16px;
    opacity: 0.6;
    text-align: center;
  }
</style>
