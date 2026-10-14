<script lang="ts">
  import type { ConflictFileView, ConflictSides, ConflictsHostMessage } from '../../shared/conflictsProtocol';
  import type { OperationKind } from '../../shared/model';
  import { basename, dirname } from '../format';
  import { postConflicts } from '../vscode';

  let files = $state.raw<ConflictFileView[]>([]);
  let sides = $state<ConflictSides>({ ours: '', theirs: '' });
  let title = $state('');
  let operation = $state<OperationKind | undefined>(undefined);
  let selected = $state.raw<ReadonlySet<string>>(new Set());
  let anchor = $state<string | undefined>(undefined);
  let busy = $state(false);
  let loaded = $state(false);

  $effect(() => {
    const listener = (event: MessageEvent<ConflictsHostMessage>) => handle(event.data);
    window.addEventListener('message', listener);
    postConflicts({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  });

  function handle(message: ConflictsHostMessage): void {
    if (message.type === 'busy') {
      busy = message.value;
      return;
    }
    files = message.files;
    sides = message.sides;
    title = message.title;
    operation = message.operation;
    loaded = true;
    const paths = new Set(files.map((f) => f.path));
    const kept = [...selected].filter((p) => paths.has(p));
    selected = new Set(kept.length ? kept : files.slice(0, 1).map((f) => f.path));
  }

  function click(event: MouseEvent, file: ConflictFileView): void {
    if (event.shiftKey && anchor) {
      const from = files.findIndex((f) => f.path === anchor);
      const to = files.findIndex((f) => f.path === file.path);
      const [a, b] = from < to ? [from, to] : [to, from];
      selected = new Set(files.slice(a, b + 1).map((f) => f.path));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selected);
      if (next.has(file.path)) next.delete(file.path);
      else next.add(file.path);
      selected = next;
    } else {
      selected = new Set([file.path]);
    }
    anchor = file.path;
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      if (event.key === 'Enter' && selected.size === 1)
        postConflicts({ type: 'merge', path: [...selected][0] });
      return;
    }
    event.preventDefault();
    const index = files.findIndex((f) => selected.has(f.path));
    const next = files[Math.max(0, Math.min(files.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      selected = new Set([next.path]);
      anchor = next.path;
    }
  }

  const describe = (present: boolean, base: boolean) =>
    present ? (base ? 'изменён' : 'добавлен') : 'удалён';
  const chosen = $derived(files.filter((f) => selected.has(f.path)));
  const single = $derived(chosen.length === 1 ? chosen[0] : undefined);
  const canMerge = $derived(!!single && single.ours && single.theirs);
  const resolve = (side: 'ours' | 'theirs') =>
    postConflicts({ type: 'resolve', side, paths: chosen.map((f) => f.path) });
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') postConflicts({ type: 'close' });
  }}
/>

<div class="app">
  <h1><i class="codicon codicon-warning"></i> Конфликты <span class="sub">{title}</span></h1>

  {#if !loaded}
    <div class="empty">Загрузка…</div>
  {:else if files.length === 0}
    <div class="done">
      <i class="codicon codicon-pass-filled"></i>
      {#if operation}
        Все конфликты разрешены — можно продолжать.
      {:else}
        Конфликтов нет.
      {/if}
    </div>
  {:else}
    <div class="body">
      <div class="table" role="listbox" tabindex="0" aria-multiselectable="true" onkeydown={onKey}>
        <div class="head">
          <span>Файл</span>
          <span title="ours">{sides.ours}</span>
          <span title="theirs">{sides.theirs}</span>
        </div>
        {#each files as file (file.path)}
          <div
            class="row"
            class:selected={selected.has(file.path)}
            role="option"
            tabindex="-1"
            aria-selected={selected.has(file.path)}
            onclick={(e) => click(e, file)}
            ondblclick={() => postConflicts({ type: 'merge', path: file.path })}
            onkeydown={() => {}}
          >
            <span class="file">
              <span class="name">{basename(file.path)}</span>
              <span class="dir">{dirname(file.path)}</span>
            </span>
            <span class="side" class:gone={!file.ours}>{describe(file.ours, file.base)}</span>
            <span class="side" class:gone={!file.theirs}>{describe(file.theirs, file.base)}</span>
          </div>
        {/each}
      </div>
      <div class="actions buttons">
        <button disabled={busy || !chosen.length} title="git checkout --ours" onclick={() => resolve('ours')}
          >Взять {sides.ours}</button
        >
        <button
          disabled={busy || !chosen.length}
          title="git checkout --theirs"
          onclick={() => resolve('theirs')}>Взять {sides.theirs}</button
        >
        <button
          class="primary"
          disabled={busy || !canMerge}
          title={single && !canMerge
            ? 'Файл удалён на одной из сторон — выберите, какую версию взять'
            : 'Трёхпанельное слияние (двойной клик)'}
          onclick={() => single && postConflicts({ type: 'merge', path: single.path })}>Слить…</button
        >
        <p class="hint">
          В редакторе слияния: слева — {sides.ours}, справа — {sides.theirs}, снизу — результат. Сохраните
          результат без маркеров конфликта — файл отметится как разрешённый.
        </p>
      </div>
    </div>
  {/if}

  <div class="buttons footer">
    {#if operation}
      <button
        title="git {operation} --abort"
        onclick={() => postConflicts({ type: 'operation', action: 'abort' })}>Прервать {operation}</button
      >
    {/if}
    <span class="spacer"></span>
    {#if operation}
      <button
        class:primary={files.length === 0}
        disabled={files.length > 0}
        title="git {operation} --continue"
        onclick={() => postConflicts({ type: 'operation', action: 'continue' })}
        >Продолжить {operation}</button
      >
    {/if}
    <button onclick={() => postConflicts({ type: 'close' })}>Закрыть</button>
  </div>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 12px 16px;
    gap: 10px;
  }
  h1 {
    margin: 0;
    font-size: 1.3em;
    font-weight: 600;
  }
  h1 .codicon {
    color: var(--vscode-charts-orange);
  }
  .sub {
    margin-left: 6px;
    font-weight: normal;
    color: var(--vscode-descriptionForeground);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 260px;
    gap: 12px;
  }
  .table {
    overflow: auto;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    outline: none;
  }
  .head,
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(90px, 0.6fr) minmax(90px, 0.6fr);
    gap: 10px;
    padding: 2px 8px;
    white-space: nowrap;
  }
  .head {
    position: sticky;
    top: 0;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    color: var(--vscode-descriptionForeground);
  }
  .head span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row {
    cursor: default;
  }
  .row:hover:not(.selected) {
    background: var(--vscode-list-hoverBackground);
  }
  .row.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
  }
  .table:focus .row.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .file {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name {
    color: var(--vscode-gitDecoration-conflictingResourceForeground);
  }
  .row.selected .name {
    color: inherit;
  }
  .dir {
    margin-left: 6px;
    color: var(--vscode-descriptionForeground);
  }
  .side.gone {
    color: var(--vscode-gitDecoration-deletedResourceForeground);
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .actions button {
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    margin: 6px 0 0;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
  }
  .done {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 1.1em;
  }
  .done .codicon {
    color: var(--vscode-charts-green);
  }
  .empty {
    color: var(--vscode-descriptionForeground);
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
</style>
