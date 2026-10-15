<script lang="ts">
  import { formatFullDate, shortHash } from '../format';
  import type { LogStore } from '../store.svelte';
  import { post } from '../vscode';
  import FileList from './FileList.svelte';
  import LinkedText from './LinkedText.svelte';
  import { t } from '../../shared/l10n';

  interface Props {
    store: LogStore;
    fileView: 'tree' | 'list';
    groupByDirectory: boolean;
    onview: (view: 'tree' | 'list') => void;
    ongroup: (value: boolean) => void;
  }

  let { store, fileView, groupByDirectory, onview, ongroup }: Props = $props();

  const details = $derived(store.details);
  const autolinks = $derived(store.hosting?.autolinks ?? []);
  const single = $derived(details?.commits.length === 1 ? details.commits[0] : undefined);
</script>

<div class="details">
  {#if !details}
    <div class="placeholder">{t('Select a commit')}</div>
  {:else}
    <div class="info">
      {#if single}
        {@const newline = single.message.indexOf('\n')}
        <div class="subject">
          <LinkedText
            text={newline < 0 ? single.message : single.message.slice(0, newline)}
            rules={autolinks}
          />
        </div>
        {#if newline >= 0}<div class="body">
            <LinkedText text={single.message.slice(newline + 1).trim()} rules={autolinks} />
          </div>{/if}
        <div class="meta">
          <button
            class="hash"
            title={t('Copy hash')}
            onclick={() => post({ type: 'commitAction', action: 'copyHash', hash: single.hash })}
            >{shortHash(single.hash)}</button
          >
          <span>{single.authorName} &lt;{single.authorEmail}&gt;</span>
          <span>{formatFullDate(single.authorDate)}</span>
          {#if single.committerEmail !== single.authorEmail || single.commitDate !== single.authorDate}
            <span class="dim"
              >{t('committed by {0}, {1}', single.committerName, formatFullDate(single.commitDate))}</span
            >
          {/if}
          {#if single.parents.length}
            <span class="parents">
              {single.parents.length > 1 ? t('parents:') : t('parent:')}
              {#each single.parents as parent (parent)}
                <button class="link" onclick={() => store.reveal(parent)}>{shortHash(parent)}</button>
              {/each}
            </span>
          {/if}
        </div>
      {:else}
        <div class="subject">{details.changeSet.title}</div>
        <div class="meta">
          <span>{t('{0} commits, changes {1}', details.commits.length, details.changeSet.range)}</span>
          {#each details.commits as commit (commit.hash)}
            <button class="link commit" onclick={() => store.reveal(commit.hash)}>
              {shortHash(commit.hash)}
              {commit.message.split('\n')[0]}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="files-toolbar">
      <span class="count">{t('{0} file(s)', details.changeSet.files.length)}</span>
      <span class="spacer"></span>
      <button
        class="toggle"
        class:on={fileView === 'tree'}
        title={t('As a tree')}
        onclick={() => onview('tree')}>{t('Tree')}</button
      >
      <button
        class="toggle"
        class:on={fileView === 'list'}
        title={t('As a list')}
        onclick={() => onview('list')}>{t('List')}</button
      >
      {#if fileView === 'list'}
        <button
          class="toggle"
          class:on={groupByDirectory}
          title={t('Group by folder')}
          onclick={() => ongroup(!groupByDirectory)}>{t('By folder')}</button
        >
      {/if}
    </div>
    {#key details.changeSet.id}
      <FileList changeSet={details.changeSet} view={fileView} {groupByDirectory} />
    {/key}
  {/if}
</div>

<style>
  .details {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
  }
  .placeholder {
    margin: auto;
    opacity: 0.6;
  }
  .info {
    flex: none;
    max-height: 45%;
    overflow: auto;
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  }
  .subject {
    white-space: pre-wrap;
    word-break: break-word;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .body {
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 8px;
    user-select: text;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.92em;
    opacity: 0.85;
  }
  .dim {
    opacity: 0.7;
  }
  .hash,
  .link {
    align-self: flex-start;
    padding: 0;
    border: none;
    background: none;
    color: var(--vscode-textLink-foreground);
    font: inherit;
    font-family: var(--vscode-editor-font-family);
    cursor: pointer;
    text-align: left;
  }
  .link.commit {
    font-family: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .parents .link {
    margin-left: 4px;
  }
  .files-toolbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 6px;
    font-size: 0.9em;
  }
  .count {
    opacity: 0.7;
  }
  .spacer {
    flex: 1;
  }
  .toggle {
    padding: 1px 6px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    opacity: 0.7;
  }
  .toggle.on {
    opacity: 1;
    border-color: var(--vscode-focusBorder);
  }
</style>
