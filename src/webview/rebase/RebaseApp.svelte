<script lang="ts">
  import type { FileChange } from '../../shared/model';
  import type { RebaseAction, RebaseEntry, RebaseHostMessage } from '../../shared/rebaseProtocol';
  import { basename, dirname, formatDate, shortHash } from '../format';
  import { postRebase } from '../vscode';

  interface Row {
    hash: string;
    action: RebaseAction;
    message: string;
    original: string;
    authorName: string;
    authorDate: number;
  }

  const actions: { action: RebaseAction; label: string; key: string; title: string }[] = [
    { action: 'pick', label: 'Pick', key: 'p', title: 'Оставить как есть' },
    { action: 'reword', label: 'Reword', key: 'r', title: 'Изменить сообщение' },
    { action: 'edit', label: 'Edit', key: 'e', title: 'Остановиться на коммите, чтобы поправить его' },
    {
      action: 'squash',
      label: 'Squash',
      key: 's',
      title: 'Объединить с коммитом выше, сообщение добавить к его',
    },
    { action: 'fixup', label: 'Fixup', key: 'f', title: 'Объединить с коммитом выше, сообщение отбросить' },
    { action: 'drop', label: 'Drop', key: 'd', title: 'Удалить коммит' },
  ];

  let rows = $state<Row[]>([]);
  let branch = $state('');
  let base = $state<string | undefined>(undefined);
  let published = $state(0);
  let selected = $state(0);
  let files = $state.raw<FileChange[]>([]);
  let filesOf = $state<string | undefined>(undefined);
  let error = $state<string | undefined>(undefined);
  let loaded = $state(false);
  /** Order the dialog opened with, to tell whether anything was changed. */
  let order: string[] = [];
  let dragFrom = $state<number | undefined>(undefined);
  let dropAt = $state<number | undefined>(undefined);
  let list = $state<HTMLElement>();
  let messageBox = $state<HTMLTextAreaElement>();

  $effect(() => {
    const listener = (event: MessageEvent<RebaseHostMessage>) => handle(event.data);
    window.addEventListener('message', listener);
    postRebase({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  });

  function handle(message: RebaseHostMessage): void {
    switch (message.type) {
      case 'state': {
        const commits = new Map(message.commits.map((c) => [c.hash, c]));
        rows = message.initial.map((entry) => {
          const commit = commits.get(entry.hash)!;
          return {
            hash: entry.hash,
            action: entry.action,
            message: entry.message ?? commit.message,
            original: commit.message,
            authorName: commit.authorName,
            authorDate: commit.authorDate,
          };
        });
        order = rows.map((r) => r.hash);
        branch = message.branch;
        base = message.base;
        published = message.published;
        error = undefined;
        loaded = true;
        select(
          Math.max(
            0,
            rows.findIndex((r) => r.hash === message.focus),
          ),
        );
        if (message.focus) queueMicrotask(() => messageBox?.focus());
        else queueMicrotask(() => list?.focus());
        break;
      }
      case 'files':
        if (message.hash === filesOf) files = message.files;
        break;
      case 'error':
        error = message.message;
        loaded = true;
        break;
    }
  }

  function select(index: number): void {
    if (index < 0 || index >= rows.length) return;
    selected = index;
    const hash = rows[index].hash;
    if (filesOf !== hash) {
      filesOf = hash;
      files = [];
      postRebase({ type: 'selectCommit', hash });
    }
    queueMicrotask(() =>
      list?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }),
    );
  }

  const isMeld = (action: RebaseAction) => action === 'squash' || action === 'fixup';

  /** The commit a squash or fixup row is melded into: the nearest kept commit above it. */
  function headOf(index: number): Row | undefined {
    for (let i = index - 1; i >= 0; i--) {
      const action = rows[i].action;
      if (action === 'drop' || isMeld(action)) continue;
      return rows[i];
    }
    return undefined;
  }

  /** A squashed commit adds its message to the commit it goes into; undoing the squash takes it away. */
  function setAction(index: number, action: RebaseAction): void {
    const row = rows[index];
    if (!row || row.action === action) return;
    const head = headOf(index);
    if (row.action === 'squash' && head)
      head.message = head.message.replace(`\n\n${row.original.trim()}`, '');
    if (action === 'squash' && head) head.message = `${head.message.trimEnd()}\n\n${row.original.trim()}`;
    row.action = action;
    if (action === 'reword') queueMicrotask(() => messageBox?.focus());
  }

  function move(from: number, to: number): void {
    if (from === to || to < 0 || to >= rows.length) return;
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row);
    selected = to;
  }

  function onListKey(event: KeyboardEvent): void {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      move(selected, selected + (event.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      select(selected + (event.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    if (event.key === 'Delete') {
      setAction(selected, 'drop');
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const picked = actions.find((a) => a.key === event.key.toLowerCase());
    if (picked) {
      event.preventDefault();
      setAction(selected, picked.action);
    }
  }

  const current = $derived(rows[selected]);
  const firstKept = $derived(rows.find((r) => r.action !== 'drop'));
  const invalid = $derived(
    firstKept && isMeld(firstKept.action)
      ? 'Первый оставшийся коммит не может объединяться с предыдущим — его не с чем объединить.'
      : undefined,
  );
  const changed = $derived(
    rows.some((r, i) => r.action !== 'pick' || r.message.trim() !== r.original.trim() || r.hash !== order[i]),
  );

  function start(): void {
    if (invalid || !changed) return;
    const entries: RebaseEntry[] = rows.map((r) => ({
      hash: r.hash,
      action: r.action,
      message: isMeld(r.action) || r.action === 'drop' ? undefined : r.message,
    }));
    postRebase({ type: 'start', entries });
  }

  const messageHint = $derived.by(() => {
    if (!current) return '';
    if (current.action === 'drop') return 'Коммит будет удалён.';
    if (current.action === 'fixup') return 'Изменения войдут в коммит выше, сообщение отбрасывается.';
    if (current.action === 'squash')
      return 'Изменения и сообщение войдут в коммит выше — правьте итоговое сообщение там.';
    return '';
  });

  const statusIcons: Record<string, string> = {
    A: 'diff-added',
    M: 'diff-modified',
    D: 'diff-removed',
    R: 'diff-renamed',
    C: 'diff-added',
    T: 'diff-modified',
    U: 'warning',
  };
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') postRebase({ type: 'cancel' });
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') start();
  }}
/>

<div class="app">
  <h1>
    <i class="codicon codicon-git-pull-request-draft"></i> Interactive rebase
    {#if branch}<span class="sub">{branch}{base ? ` на ${shortHash(base)}` : ' от первого коммита'}</span
      >{/if}
  </h1>

  {#if !loaded}
    <div class="empty">Загрузка…</div>
  {:else if rows.length}
    <div class="toolbar" role="toolbar">
      {#each actions as a (a.action)}
        <button
          class="act {a.action}"
          class:on={current?.action === a.action}
          title="{a.title} ({a.key.toUpperCase()})"
          onclick={() => setAction(selected, a.action)}>{a.label}</button
        >
      {/each}
      <span class="gap"></span>
      <button title="Выше (Alt+↑)" aria-label="Выше" onclick={() => move(selected, selected - 1)}
        ><i class="codicon codicon-arrow-up"></i></button
      >
      <button title="Ниже (Alt+↓)" aria-label="Ниже" onclick={() => move(selected, selected + 1)}
        ><i class="codicon codicon-arrow-down"></i></button
      >
      <span class="gap"></span>
      <span class="hint">Сверху — старые коммиты, применяются по порядку. Строки можно перетаскивать.</span>
    </div>

    <div class="rows" role="listbox" tabindex="0" aria-label="Коммиты" bind:this={list} onkeydown={onListKey}>
      {#each rows as row, index (row.hash)}
        <div
          class="row {row.action}"
          class:selected={index === selected}
          class:drop-before={dropAt === index && dragFrom !== undefined && dragFrom > index}
          class:drop-after={dropAt === index && dragFrom !== undefined && dragFrom < index}
          data-index={index}
          role="option"
          tabindex="-1"
          aria-selected={index === selected}
          draggable="true"
          onclick={() => select(index)}
          onkeydown={() => {}}
          ondragstart={(e) => {
            dragFrom = index;
            e.dataTransfer?.setData('text/plain', row.hash);
          }}
          ondragover={(e) => {
            e.preventDefault();
            dropAt = index;
          }}
          ondrop={(e) => {
            e.preventDefault();
            if (dragFrom !== undefined) move(dragFrom, index);
            dragFrom = dropAt = undefined;
          }}
          ondragend={() => (dragFrom = dropAt = undefined)}
        >
          <i class="codicon codicon-gripper grip"></i>
          <select
            class="action"
            value={row.action}
            aria-label="Действие"
            onclick={(e) => e.stopPropagation()}
            onchange={(e) => setAction(index, (e.currentTarget as HTMLSelectElement).value as RebaseAction)}
          >
            {#each actions as a (a.action)}<option value={a.action}>{a.label.toLowerCase()}</option>{/each}
          </select>
          <span class="hash">{shortHash(row.hash)}</span>
          <span class="subject">
            {#if isMeld(row.action)}<i class="codicon codicon-arrow-small-up"></i>{/if}
            {row.message.split('\n')[0]}
            {#if row.action === 'reword' || (row.message.trim() !== row.original.trim() && !isMeld(row.action))}
              <span class="edited">сообщение изменено</span>
            {/if}
          </span>
          <span class="author">{row.authorName}</span>
          <span class="date">{formatDate(row.authorDate)}</span>
        </div>
      {/each}
    </div>

    <div class="bottom">
      <div class="message">
        <div class="label">Сообщение {current ? shortHash(current.hash) : ''}</div>
        {#if messageHint}<div class="hint">{messageHint}</div>{/if}
        {#if current}
          <textarea
            bind:this={messageBox}
            value={current.action === 'squash' || current.action === 'fixup'
              ? current.original
              : current.message}
            disabled={isMeld(current.action) || current.action === 'drop'}
            spellcheck="false"
            oninput={(e) => {
              current.message = (e.currentTarget as HTMLTextAreaElement).value;
              if (current.action === 'pick') current.action = 'reword';
            }}></textarea>
        {/if}
      </div>
      <div class="files" aria-label="Файлы коммита">
        {#each files as file, index (file.path)}
          <div
            class="file"
            role="button"
            tabindex="0"
            title="Двойной клик — diff"
            ondblclick={() => filesOf && postRebase({ type: 'openFile', hash: filesOf, index })}
            onkeydown={(e) =>
              e.key === 'Enter' && filesOf && postRebase({ type: 'openFile', hash: filesOf, index })}
          >
            <i class="codicon codicon-{statusIcons[file.status] ?? 'file'} status-{file.status}"></i>
            <span class="file-name">{basename(file.path)}</span>
            <span class="dir">{dirname(file.path)}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if error}<div class="error"><i class="codicon codicon-error"></i> {error}</div>{/if}

  <div class="buttons footer">
    {#if invalid}
      <span class="warn">{invalid}</span>
    {:else if published > 0}
      <span class="warn"
        ><i class="codicon codicon-warning"></i>
        {published} из {rows.length} коммитов уже на сервере — после rebase ветку придётся пушить с force-with-lease.</span
      >
    {/if}
    <span class="spacer"></span>
    <button onclick={() => postRebase({ type: 'cancel' })}>Отмена</button>
    <button
      class="primary"
      disabled={!!invalid || !changed || !rows.length}
      title="Ctrl+Enter"
      onclick={start}>Начать rebase</button
    >
  </div>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 12px 16px;
    gap: 8px;
  }
  h1 {
    margin: 0;
    font-size: 1.3em;
    font-weight: 600;
  }
  .sub {
    font-weight: normal;
    color: var(--vscode-descriptionForeground);
    margin-left: 6px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .toolbar button {
    padding: 2px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    font: inherit;
    cursor: pointer;
  }
  .toolbar button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  .toolbar button.on {
    outline: 1px solid var(--vscode-focusBorder);
  }
  .gap {
    width: 10px;
  }
  .hint {
    color: var(--vscode-descriptionForeground);
  }
  .rows {
    flex: 1 1 50%;
    min-height: 120px;
    overflow: auto;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    outline: none;
  }
  .rows:focus-within .row.selected,
  .rows:focus .row.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .row {
    display: grid;
    grid-template-columns: auto 86px 70px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 8px;
    padding: 1px 8px 1px 4px;
    cursor: default;
    white-space: nowrap;
    border-top: 2px solid transparent;
    border-bottom: 2px solid transparent;
  }
  .row.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
  }
  .row:hover:not(.selected) {
    background: var(--vscode-list-hoverBackground);
  }
  .row.drop-before {
    border-top-color: var(--vscode-focusBorder);
  }
  .row.drop-after {
    border-bottom-color: var(--vscode-focusBorder);
  }
  .grip {
    color: var(--vscode-descriptionForeground);
    cursor: grab;
  }
  .action {
    padding: 0 4px;
  }
  .hash,
  .author,
  .date {
    color: var(--vscode-descriptionForeground);
  }
  .row.selected .hash,
  .row.selected .author,
  .row.selected .date {
    color: inherit;
  }
  .hash {
    font-family: var(--vscode-editor-font-family);
  }
  .subject {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .edited {
    margin-left: 6px;
    font-size: 0.9em;
    color: var(--vscode-charts-blue);
  }
  .row.drop .subject,
  .row.drop .hash {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .row.reword .action,
  .act.reword {
    color: var(--vscode-charts-blue);
  }
  .row.edit .action,
  .act.edit {
    color: var(--vscode-charts-yellow);
  }
  .row.squash .action,
  .row.fixup .action,
  .act.squash,
  .act.fixup {
    color: var(--vscode-charts-purple);
  }
  .row.drop .action,
  .act.drop {
    color: var(--vscode-charts-red);
  }
  .row.squash .subject,
  .row.fixup .subject {
    padding-left: 12px;
  }
  .bottom {
    flex: 1 1 40%;
    min-height: 140px;
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 10px;
  }
  .message {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
  }
  .label {
    font-weight: 600;
  }
  textarea {
    flex: 1;
    min-height: 60px;
    resize: none;
    padding: 6px;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
    user-select: text;
  }
  textarea:focus {
    border-color: var(--vscode-focusBorder);
  }
  textarea:disabled {
    opacity: 0.6;
  }
  .files {
    overflow: auto;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
  }
  .file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .file:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .dir {
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status-A,
  .status-C {
    color: var(--vscode-gitDecoration-addedResourceForeground);
  }
  .status-M,
  .status-T {
    color: var(--vscode-gitDecoration-modifiedResourceForeground);
  }
  .status-D {
    color: var(--vscode-gitDecoration-deletedResourceForeground);
  }
  .status-R {
    color: var(--vscode-gitDecoration-renamedResourceForeground);
  }
  .empty {
    padding: 8px;
    color: var(--vscode-descriptionForeground);
  }
  .error {
    padding: 6px 8px;
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    background: var(--vscode-inputValidation-errorBackground);
    user-select: text;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
  .warn {
    color: var(--vscode-charts-orange);
  }
</style>
