<script lang="ts">
  import type { FileChange } from '../../shared/model';
  import type { PushBranchView, PushHostMessage } from '../../shared/pushProtocol';
  import Check from '../commit/Check.svelte';
  import { basename, dirname, formatDate, shortHash } from '../format';
  import { postPush } from '../vscode';
  import { t } from '../../shared/l10n';

  interface Row extends PushBranchView {
    force: boolean;
  }

  let rows = $state<Row[]>([]);
  let remotes = $state<string[]>([]);
  let active = $state(0);
  let selectedCommit = $state<string | undefined>(undefined);
  let files = $state.raw<FileChange[]>([]);
  let busy = $state(false);
  let error = $state<string | undefined>(undefined);
  let loaded = $state(false);

  $effect(() => {
    const listener = (event: MessageEvent<PushHostMessage>) => handle(event.data);
    window.addEventListener('message', listener);
    postPush({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  });

  function handle(message: PushHostMessage): void {
    switch (message.type) {
      case 'state':
        remotes = message.remotes;
        rows = message.branches.map((b) => ({ ...b, force: false }));
        active = 0;
        loaded = true;
        selectCommit(rows[0]?.commits[0]?.hash);
        break;
      case 'busy':
        busy = message.value;
        if (busy) error = undefined;
        break;
      case 'files':
        if (message.hash === selectedCommit) files = message.files;
        break;
      case 'error':
        error = message.message;
        loaded = true;
        break;
    }
  }

  function selectCommit(hash: string | undefined): void {
    selectedCommit = hash;
    files = [];
    if (hash) postPush({ type: 'selectCommit', hash });
  }

  function activate(index: number): void {
    if (active === index) return;
    active = index;
    selectCommit(rows[index]?.commits[0]?.hash);
  }

  /** A remote branch with commits missing locally takes the push only by force. */
  const needsForce = (row: Row) => row.existsOnRemote && row.behind > 0;
  const blocked = (row: Row) => needsForce(row) && !row.force;
  const checkedRows = $derived(rows.filter((r) => r.checked));
  const canPush = $derived(!busy && checkedRows.length > 0 && !checkedRows.some(blocked));
  const current = $derived(rows[active]);

  function push(): void {
    if (!canPush) return;
    postPush({
      type: 'push',
      branches: checkedRows.map((r) => ({
        branch: r.branch,
        remote: r.remote,
        target: r.target.trim(),
        force: needsForce(r) && r.force,
      })),
    });
  }

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
    if (e.key === 'Escape') postPush({ type: 'cancel' });
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') push();
  }}
/>

<div class="app">
  <h1><i class="codicon codicon-repo-push"></i> Push</h1>

  {#if !loaded}
    <div class="empty">{t('Loading…')}</div>
  {:else}
    <div class="branches" role="listbox" aria-label={t('Branches')}>
      {#each rows as row, index (row.branch)}
        <div
          class="branch"
          class:active={index === active}
          role="option"
          tabindex="0"
          aria-selected={index === active}
          onclick={() => activate(index)}
          onkeydown={(e) => {
            if (e.key === ' ') {
              e.preventDefault();
              row.checked = !row.checked;
            }
          }}
        >
          <Check
            state={row.checked ? 'all' : 'none'}
            label={t('Push {0}', row.branch)}
            onchange={(value) => (row.checked = value)}
          />
          <i class="codicon codicon-git-branch"></i>
          <span class="name">{row.branch}</span>
          <span class="arrow">→</span>
          {#if remotes.length > 1 && !row.hasUpstream}
            <select bind:value={row.remote} onclick={(e) => e.stopPropagation()}>
              {#each remotes as remote (remote)}<option value={remote}>{remote}</option>{/each}
            </select>
          {:else}
            <span class="remote">{row.remote}</span>
          {/if}
          <span class="colon">:</span>
          {#if row.hasUpstream}
            <span class="target">{row.target}</span>
          {:else}
            <input
              class="target-input"
              bind:value={row.target}
              spellcheck="false"
              aria-label={t('Branch name on the server')}
              onclick={(e) => e.stopPropagation()}
            />
          {/if}
          {#if !row.existsOnRemote}<span class="badge new">{t('new')}</span>{/if}
          <span class="count" title={t('Commits to push')}>↑{row.commits.length}</span>
          {#if needsForce(row)}
            <span class="badge warn" title={t('The server has commits that are not here')}>↓{row.behind}</span
            >
            {#if row.protected}
              <span class="badge bad" title="kleio.push.protectedBranches">{t('force forbidden')}</span>
            {:else}
              <label class="force">
                <input type="checkbox" bind:checked={row.force} /> force-with-lease
              </label>
            {/if}
          {/if}
        </div>
      {/each}
    </div>

    {#if current}
      <div class="body">
        <div class="commits" role="listbox" aria-label={t('Commits of {0}', current.branch)}>
          {#if current.commits.length === 0}
            <div class="empty">
              {t('Nothing to push: the branch matches {0}.', `${current.remote}/${current.target}`)}
            </div>
          {/if}
          {#each current.commits as commit (commit.hash)}
            <div
              class="commit"
              class:selected={commit.hash === selectedCommit}
              role="option"
              tabindex="0"
              aria-selected={commit.hash === selectedCommit}
              onclick={() => selectCommit(commit.hash)}
              onkeydown={(e) => e.key === 'Enter' && selectCommit(commit.hash)}
            >
              <span class="subject">{commit.subject}</span>
              <span class="author">{commit.authorName}</span>
              <span class="date">{formatDate(commit.authorDate)}</span>
              <span class="hash">{shortHash(commit.hash)}</span>
            </div>
          {/each}
        </div>
        <div class="files" aria-label={t('Files of the commit')}>
          {#each files as file, index (file.path)}
            <div
              class="file"
              role="button"
              tabindex="0"
              title={t('Double-click for the diff')}
              ondblclick={() => selectedCommit && postPush({ type: 'openFile', hash: selectedCommit, index })}
              onkeydown={(e) =>
                e.key === 'Enter' &&
                selectedCommit &&
                postPush({ type: 'openFile', hash: selectedCommit, index })}
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
      {#if checkedRows.some(blocked)}
        <span class="hint"
          >{t('The branch has diverged from the server: update it or check force-with-lease.')}</span
        >
      {/if}
      <span class="spacer"></span>
      <button onclick={() => postPush({ type: 'cancel' })}>{t('Cancel')}</button>
      <button class="primary" disabled={!canPush} onclick={push} title="Ctrl+Enter"
        >{busy ? 'Push…' : checkedRows.some((r) => r.force && needsForce(r)) ? 'Force push' : 'Push'}</button
      >
    </div>
  {/if}
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
  .branches {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
  }
  .branch {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    cursor: pointer;
    min-height: 28px;
  }
  .branch.active {
    background: var(--vscode-list-inactiveSelectionBackground);
  }
  .branch:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .name {
    font-weight: 600;
  }
  .arrow,
  .colon {
    color: var(--vscode-descriptionForeground);
  }
  .target-input {
    width: 220px;
  }
  .count {
    margin-left: auto;
    color: var(--vscode-charts-green);
  }
  .badge {
    padding: 0 6px;
    border-radius: 8px;
    font-size: 0.9em;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .badge.warn {
    background: transparent;
    color: var(--vscode-charts-orange);
  }
  .badge.bad {
    background: transparent;
    color: var(--vscode-errorForeground);
  }
  .force {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--vscode-charts-orange);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 10px;
  }
  .commits,
  .files {
    overflow: auto;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
  }
  .commit {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    gap: 10px;
    padding: 2px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .commit.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .commit:hover:not(.selected),
  .file:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .subject {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .author,
  .date,
  .hash,
  .dir {
    color: var(--vscode-descriptionForeground);
  }
  .commit.selected .author,
  .commit.selected .date,
  .commit.selected .hash {
    color: inherit;
  }
  .hash {
    font-family: var(--vscode-editor-font-family);
  }
  .file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .dir {
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
  .hint {
    color: var(--vscode-charts-orange);
  }
</style>
