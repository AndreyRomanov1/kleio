<script lang="ts">
  import { formatDate } from '../format';
  import { menu } from '../menu.svelte';
  import { postCommit } from '../vscode';
  import type { CommitStore } from './commitStore.svelte';

  interface Props {
    store: CommitStore;
  }

  let { store }: Props = $props();
  let message = $state('');
  let includeUntracked = $state(true);

  type Action = 'show' | 'apply' | 'pop' | 'drop';
  const act = (action: Action, selector: string, hash: string) =>
    postCommit({ type: 'stashAction', action, selector, hash });

  function save(): void {
    postCommit({ type: 'stashSave', message, includeUntracked });
    message = '';
  }
</script>

<div class="stash">
  <div class="save">
    <input
      placeholder="Описание (необязательно)"
      bind:value={message}
      onkeydown={(e) => e.key === 'Enter' && save()}
      spellcheck="false"
    />
    <label><input type="checkbox" bind:checked={includeUntracked} /> с неотслеживаемыми</label>
    <button class="primary" disabled={store.files.length === 0} onclick={save}>Спрятать изменения</button>
  </div>
  <div class="list">
    {#each store.stashes as stash (stash.hash)}
      <div
        class="item"
        role="listitem"
        ondblclick={() => act('show', stash.selector, stash.hash)}
        oncontextmenu={(e) =>
          menu.show(e, [
            { label: 'Показать изменения', icon: 'diff', run: () => act('show', stash.selector, stash.hash) },
            'separator',
            { label: 'Применить', icon: 'check', run: () => act('apply', stash.selector, stash.hash) },
            { label: 'Применить и удалить (pop)', run: () => act('pop', stash.selector, stash.hash) },
            'separator',
            { label: 'Удалить…', icon: 'trash', run: () => act('drop', stash.selector, stash.hash) },
          ])}
      >
        <div class="text">
          <span class="message" title={stash.message}>{stash.message}</span>
          <span class="meta">{stash.selector} · {formatDate(stash.date)}</span>
        </div>
        <span class="actions">
          <button title="Показать изменения" onclick={() => act('show', stash.selector, stash.hash)}
            ><i class="codicon codicon-diff"></i></button
          >
          <button title="Применить" onclick={() => act('apply', stash.selector, stash.hash)}
            ><i class="codicon codicon-check"></i></button
          >
          <button title="Применить и удалить (pop)" onclick={() => act('pop', stash.selector, stash.hash)}
            ><i class="codicon codicon-check-all"></i></button
          >
          <button title="Удалить" onclick={() => act('drop', stash.selector, stash.hash)}
            ><i class="codicon codicon-trash"></i></button
          >
        </span>
      </div>
    {:else}
      <div class="empty">Спрятанных изменений нет</div>
    {/each}
  </div>
</div>

<style>
  .stash {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .save {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  }
  label {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .list {
    flex: 1;
    overflow: auto;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    cursor: default;
  }
  .item:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .message {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-size: 0.85em;
    opacity: 0.65;
  }
  .actions {
    display: flex;
    visibility: hidden;
  }
  .item:hover .actions {
    visibility: visible;
  }
  .actions button {
    border: none;
    background: none;
    color: inherit;
    padding: 2px 3px;
    cursor: pointer;
    border-radius: 3px;
  }
  .actions button:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .empty {
    padding: 16px;
    opacity: 0.6;
    text-align: center;
  }
</style>
