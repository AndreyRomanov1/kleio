<script lang="ts">
  import { isEmptyQuery, type LogQuery } from '../../shared/model';
  import { t } from '../../shared/l10n';
  import type { LogStore } from '../store.svelte';
  import { post } from '../vscode';

  interface Props {
    store: LogStore;
    onclose: () => void;
  }

  let { store, onclose }: Props = $props();

  const list = (text: string) =>
    text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  let authors = $state('');
  let since = $state('');
  let until = $state('');
  let paths = $state('');
  let changes = $state('');
  let regex = $state(false);

  // The fields follow the query the log was loaded with, e.g. after "commits by this author" in a menu.
  $effect(() => {
    const query = store.query;
    authors = (query.authors ?? []).join(', ');
    since = query.since ?? '';
    until = query.until ?? '';
    paths = (query.paths ?? []).join(', ');
    changes = query.changes ?? '';
    regex = !!query.changesRegex;
  });

  const knownAuthors = $derived(
    [...new Set((store.snapshot?.commits ?? []).map((c) => c.authorName))].sort(),
  );

  function draft(): LogQuery {
    const query: LogQuery = {};
    if (list(authors).length) query.authors = list(authors);
    if (since.trim()) query.since = since.trim();
    if (until.trim()) query.until = until.trim();
    if (list(paths).length) query.paths = list(paths);
    if (changes) {
      query.changes = changes;
      if (regex) query.changesRegex = true;
    }
    return query;
  }

  function apply(): void {
    const query = draft();
    if (JSON.stringify(query) !== JSON.stringify(store.query)) post({ type: 'setQuery', query });
  }

  function clear(): void {
    if (!isEmptyQuery(store.query)) post({ type: 'setQuery', query: {} });
    else onclose();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') apply();
    if (event.key === 'Escape') {
      event.stopPropagation();
      clear();
    }
  }
</script>

<div class="filters">
  <label title={t('Authors separated by commas; a part of the name or email is enough')}>
    {t('Author')}
    <input
      bind:value={authors}
      list="kleio-authors"
      onchange={apply}
      onkeydown={keydown}
      spellcheck="false"
    />
  </label>
  <datalist id="kleio-authors">
    {#each knownAuthors as author (author)}<option value={author}></option>{/each}
  </datalist>
  <label title={t('A date such as 2026-01-31 or a period such as 2 weeks ago')}>
    {t('Since')}
    <input class="date" bind:value={since} onchange={apply} onkeydown={keydown} placeholder="2 weeks ago" />
  </label>
  <label title={t('A date such as 2026-01-31 or a period such as 2 weeks ago')}>
    {t('Until')}
    <input class="date" bind:value={until} onchange={apply} onkeydown={keydown} placeholder="2026-01-31" />
  </label>
  <label title={t('Paths from the repository root separated by commas: files or folders')}>
    {t('Paths')}
    <input
      bind:value={paths}
      onchange={apply}
      onkeydown={keydown}
      spellcheck="false"
      placeholder="src/, README.md"
    />
  </label>
  <label
    title={regex
      ? t('Commits whose added or removed lines match the regular expression (git log -G)')
      : t('Commits that add or remove this text, e.g. where a function appeared or disappeared (git log -S)')}
  >
    {t('Changed text')}
    <input bind:value={changes} onchange={apply} onkeydown={keydown} spellcheck="false" />
  </label>
  <label class="regex" title={t('Changed text is a regular expression')}>
    <input
      type="checkbox"
      bind:checked={regex}
      onchange={() => {
        if (changes) apply();
      }}
    />.*
  </label>
  <span class="spacer"></span>
  <button class="tool" title={t('Reset the filters')} onclick={clear} disabled={isEmptyQuery(store.query)}
    >{t('Reset')}</button
  >
  <button class="tool icon" title={t('Hide the filters')} aria-label={t('Hide the filters')} onclick={onclose}
    ><i class="codicon codicon-close"></i></button
  >
</div>

<style>
  .filters {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    opacity: 0.9;
  }
  input:not([type='checkbox']) {
    width: 150px;
  }
  input.date {
    width: 100px;
  }
  .regex {
    font-family: var(--vscode-editor-font-family);
  }
  .spacer {
    flex: 1;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .tool:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .tool:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
