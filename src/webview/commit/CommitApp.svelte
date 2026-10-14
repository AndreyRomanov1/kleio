<script lang="ts">
  import type { CommitHostMessage } from '../../shared/commitProtocol';
  import ContextMenu from '../components/ContextMenu.svelte';
  import Splitter from '../components/Splitter.svelte';
  import { postCommit } from '../vscode';
  import ChangesTree from './ChangesTree.svelte';
  import { CommitStore } from './commitStore.svelte';
  import StashList from './StashList.svelte';

  const store = new CommitStore();
  let tab = $state<'commit' | 'stash'>('commit');
  let collapsed = $state<ReadonlySet<string>>(new Set());
  let showRecent = $state(false);
  let height = $state(600);

  $effect(() => {
    const listener = (event: MessageEvent<CommitHostMessage>) => store.handle(event.data);
    window.addEventListener('message', listener);
    postCommit({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  });

  const allFolders = $derived.by(() => {
    const keys = new Set<string>(['section:changes', 'section:untracked']);
    for (const file of store.files) {
      const parts = file.path.split('/');
      const prefix = file.kind === 'untracked' ? 'section:untracked' : 'section:changes';
      for (let i = 1; i < parts.length; i++) keys.add(`${prefix}/${parts.slice(0, i).join('/')}`);
    }
    return keys;
  });

  function toggle(key: string): void {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsed = next;
  }

  function openRecent(): void {
    showRecent = !showRecent;
    if (showRecent) postCommit({ type: 'requestRecentMessages' });
  }

  const checkedCount = $derived(store.checkedFiles.length);
  const canCommit = $derived(!store.busy && store.message.trim() !== '' && (checkedCount > 0 || store.amend));
</script>

<div class="app" bind:clientHeight={height}>
  <div class="tabs" role="tablist">
    <button
      class="tab"
      class:on={tab === 'commit'}
      role="tab"
      aria-selected={tab === 'commit'}
      onclick={() => (tab = 'commit')}>Коммит</button
    >
    <button
      class="tab"
      class:on={tab === 'stash'}
      role="tab"
      aria-selected={tab === 'stash'}
      onclick={() => (tab = 'stash')}
      >Stash{#if store.stashes.length}<span class="badge">{store.stashes.length}</span>{/if}</button
    >
    <span class="spacer"></span>
    {#if store.branch}<span class="branch" title="Текущая ветка"
        ><i class="codicon codicon-git-branch"></i>{store.branch}</span
      >{/if}
  </div>

  {#if store.noRepository}
    <div class="empty">В открытых папках нет git-репозитория.</div>
  {:else if tab === 'commit'}
    <div class="toolbar">
      <button title="Обновить" onclick={() => postCommit({ type: 'refresh' })}
        ><i class="codicon codicon-refresh"></i></button
      >
      <button
        title="Откатить выделенные (или отмеченные) файлы"
        disabled={store.targets.length === 0}
        onclick={() => postCommit({ type: 'rollback', paths: store.targets })}
        ><i class="codicon codicon-discard"></i></button
      >
      <button
        title="Показать diff"
        disabled={store.targets.length === 0}
        onclick={() => postCommit({ type: 'openDiff', path: store.targets[0] })}
        ><i class="codicon codicon-diff"></i></button
      >
      <span class="separator"></span>
      <button title="Развернуть всё" onclick={() => (collapsed = new Set())}
        ><i class="codicon codicon-expand-all"></i></button
      >
      <button title="Свернуть всё" onclick={() => (collapsed = allFolders)}
        ><i class="codicon codicon-collapse-all"></i></button
      >
      <button
        title={store.flat ? 'Показать деревом' : 'Показать списком'}
        class:on={store.flat}
        onclick={() => {
          store.flat = !store.flat;
          store.persist();
        }}><i class="codicon codicon-list-flat"></i></button
      >
    </div>

    <ChangesTree {store} {collapsed} ontoggle={toggle} />

    <Splitter
      vertical
      ondrag={(d) => (store.messageHeight = Math.max(70, Math.min(height - 160, store.messageHeight - d)))}
      onend={() => store.persist()}
    />

    <div class="bottom" style:height="{store.messageHeight}px">
      <div class="options">
        <label title="Дописать изменения в последний коммит и поправить его сообщение">
          <input
            type="checkbox"
            checked={store.amend}
            onchange={(e) => store.setAmend(e.currentTarget.checked)}
          />
          Amend
        </label>
        <span class="spacer"></span>
        <div class="recent">
          <button title="Недавние сообщения" onclick={openRecent}
            ><i class="codicon codicon-history"></i></button
          >
          {#if showRecent}
            <div class="recent-list" role="listbox">
              {#if !store.recent}
                <div class="recent-item dim">Загрузка…</div>
              {:else}
                {#each store.recent as recent, i (i)}
                  <button
                    class="recent-item"
                    title={recent}
                    onclick={() => {
                      store.message = recent;
                      store.persist();
                      showRecent = false;
                    }}>{recent.split('\n')[0]}</button
                  >
                {:else}
                  <div class="recent-item dim">Нет сообщений</div>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      </div>
      <textarea
        placeholder="Сообщение коммита (Ctrl+Enter — коммит)"
        bind:value={store.message}
        oninput={() => store.persist()}
        onkeydown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit) store.commit(e.shiftKey);
        }}
        spellcheck="false"></textarea>
      <div class="buttons">
        <button class="primary" disabled={!canCommit} onclick={() => store.commit(false)}>
          {store.amend ? 'Amend' : 'Commit'}
        </button>
        <button disabled={!canCommit} title="Ctrl+Shift+Enter" onclick={() => store.commit(true)}>
          {store.amend ? 'Amend' : 'Commit'} and Push
        </button>
        <span class="spacer"></span>
        <span class="count">{checkedCount} из {store.files.length}</span>
        {#if store.busy}<i class="codicon codicon-loading codicon-modifier-spin"></i>{/if}
      </div>
    </div>
  {:else}
    <StashList {store} />
  {/if}
  <ContextMenu />
</div>

<svelte:window
  onmousedown={(e) => {
    if (showRecent && !(e.target as HTMLElement).closest('.recent')) showRecent = false;
  }}
/>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .tabs {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px 0;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border: none;
    border-bottom: 2px solid transparent;
    background: none;
    color: inherit;
    font: inherit;
    opacity: 0.75;
    cursor: pointer;
  }
  .tab.on {
    opacity: 1;
    border-bottom-color: var(--vscode-focusBorder);
  }
  .badge {
    padding: 0 5px;
    border-radius: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 0.85em;
  }
  .branch {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.75;
    font-size: 0.9em;
  }
  .toolbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 3px 4px;
  }
  .toolbar button,
  .recent > button {
    display: inline-flex;
    padding: 3px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: inherit;
    cursor: pointer;
  }
  .toolbar button:hover:not(:disabled),
  .recent > button:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .toolbar button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .toolbar button.on {
    border-color: var(--vscode-focusBorder);
  }
  .separator {
    width: 1px;
    height: 16px;
    margin: 0 4px;
    background: var(--vscode-panel-border, var(--vscode-widget-border));
  }
  .bottom {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px 8px;
    min-height: 0;
  }
  .options {
    display: flex;
    align-items: center;
  }
  label {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .recent {
    position: relative;
  }
  .recent-list {
    position: absolute;
    right: 0;
    bottom: 100%;
    z-index: 50;
    width: min(420px, 90vw);
    max-height: 260px;
    overflow: auto;
    padding: 4px 0;
    background: var(--vscode-menu-background);
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));
    border-radius: 5px;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow);
  }
  .recent-item {
    display: block;
    width: 100%;
    padding: 3px 10px;
    border: none;
    background: none;
    color: var(--vscode-menu-foreground);
    font: inherit;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .recent-item:hover:not(.dim) {
    background: var(--vscode-menu-selectionBackground);
    color: var(--vscode-menu-selectionForeground);
  }
  .dim {
    opacity: 0.6;
    cursor: default;
  }
  textarea {
    flex: 1;
    min-height: 40px;
    resize: none;
    padding: 6px;
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size, var(--vscode-font-size));
    outline: none;
  }
  textarea:focus {
    border-color: var(--vscode-focusBorder);
  }
  .buttons {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .count {
    opacity: 0.65;
    font-size: 0.9em;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .empty {
    margin: auto;
    padding: 16px;
    opacity: 0.6;
    text-align: center;
  }
</style>
