<script lang="ts">
  import { locale } from '../format';
  import {
    mergeReady,
    mergeRequestStateLabel,
    mergeRequestTone,
    mergeStatusLabel,
    pipelineIcons,
  } from '../hostingView';
  import type { LogStore } from '../store.svelte';
  import { post } from '../vscode';
  import PipelineStages from './PipelineStages.svelte';
  import { t } from '../../shared/l10n';

  interface Props {
    store: LogStore;
  }

  let { store }: Props = $props();
  let element: HTMLDivElement | undefined = $state();
  let comment = $state('');
  let showAll = $state(false);
  let expandedNotes = $state<ReadonlySet<number>>(new Set());

  /** The text is in the review journal before it is sent, so the box can be cleared at once. */
  function send(draft: boolean): void {
    const number = store.card?.number;
    if (!number || !comment.trim()) return;
    post({ type: 'postComment', number, body: comment, draft });
    comment = '';
  }

  const timeFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
  function formatTime(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date);
  }

  const current = $derived(store.card);
  const card = $derived(current?.card);
  const github = $derived(store.hosting?.kind === 'github');
  const sign = $derived(github ? '#' : '!');
  const service = $derived(github ? 'GitHub' : 'GitLab');
</script>

<svelte:window
  onkeydown={(e) => {
    if (current && e.key === 'Escape') store.closeCard();
  }}
  onmousedown={(e) => {
    const target = e.target as HTMLElement;
    if (current && element && !element.contains(target) && !target.closest('.mr')) store.closeCard();
  }}
/>

{#if current}
  <div class="card" bind:this={element} role="dialog" aria-label="Merge request {sign}{current.number}">
    <div class="head">
      <span class="number">{sign}{current.number}</span>
      {#if card}
        <span class="state {mergeRequestTone(card)}">{mergeRequestStateLabel(card)}</span>
      {/if}
      <span class="spacer"></span>
      <button class="icon" title={t('Refresh')} onclick={() => store.openCard(current.number)}
        ><i class="codicon codicon-refresh"></i></button
      >
      <button class="icon" title={t('Close (Esc)')} onclick={() => store.closeCard()}
        ><i class="codicon codicon-close"></i></button
      >
    </div>

    {#if current.loading && !card}
      <div class="muted"><i class="codicon codicon-loading codicon-modifier-spin"></i> {t('Loading…')}</div>
    {:else if current.needsAuth}
      {#if github}
        <p>{t('Kleio needs access to GitHub to show the pull request and its checks.')}</p>
      {:else}
        <p>{t('Kleio needs access to GitLab to show the merge request and its pipeline.')}</p>
        <p class="muted">
          {t(
            'If the GitLab Workflow extension is signed in to this server, Kleio takes the access from there; otherwise it asks for a personal access token.',
          )}
        </p>
      {/if}
      <div class="actions">
        <button class="primary" onclick={() => post({ type: 'connectHosting', number: current.number })}
          >{t('Connect {0}', service)}</button
        >
        <button onclick={() => post({ type: 'openMergeRequest', number: current.number })}
          >{t('Open in the browser')}</button
        >
      </div>
    {:else if current.error}
      <p class="error">{current.error}</p>
      <div class="actions">
        <button onclick={() => store.openCard(current.number)}>{t('Retry')}</button>
      </div>
    {:else if card}
      <a class="title" href={card.webUrl}>{card.title}</a>
      <div class="muted">{card.author} · {card.sourceBranch} → {card.targetBranch}</div>

      <div class="facts">
        {#if mergeStatusLabel(card.mergeStatus) && card.state === 'opened'}
          <span class="fact" class:warn={!mergeReady(card.mergeStatus)}
            ><i class="codicon codicon-git-merge"></i>{mergeStatusLabel(card.mergeStatus)}</span
          >
        {/if}
        {#if card.hasConflicts}<span class="fact warn"
            ><i class="codicon codicon-warning"></i>{t('conflicts')}</span
          >{/if}
        <span class="fact"><i class="codicon codicon-comment"></i>{card.notes}</span>
      </div>

      <div class="section">
        <div class="label">
          {t('Reviewers')}{#if card.approvalsLeft > 0}<span class="muted">
              · {t('approvals needed: {0}', card.approvalsLeft)}</span
            >{/if}
        </div>
        {#if card.reviewers.length === 0 && card.approvedBy.length === 0}
          <div class="muted">{t('none assigned')}</div>
        {/if}
        {#each card.reviewers as reviewer (reviewer.name)}
          <div class="person" class:approved={reviewer.approved}>
            <i class="codicon codicon-{reviewer.approved ? 'pass-filled' : 'circle-large-outline'}"
            ></i>{reviewer.name}
          </div>
        {/each}
        {#each card.approvedBy as name (name)}
          <div class="person approved">
            <i class="codicon codicon-pass-filled"></i>{name}
            <span class="muted">{t('(not a reviewer)')}</span>
          </div>
        {/each}
      </div>

      {#if card.pipeline}
        {@const pipeline = card.pipeline}
        {@const icon = pipelineIcons[pipeline.status]}
        <div class="section">
          <div class="label pipeline-head">
            <span class="status {icon.tone}"><i class="codicon codicon-{icon.icon}"></i></span>
            <a href={pipeline.webUrl}>{github ? t('Checks') : t('Pipeline #{0}', pipeline.id)}</a>
            <span class="muted">{icon.label}</span>
            <span class="spacer"></span>
            {#if pipeline.status === 'failed' || pipeline.status === 'canceled'}
              <button
                class="small"
                title={t('Retry failed and canceled jobs')}
                onclick={() => post({ type: 'retryPipeline', pipelineId: pipeline.id, number: card.iid })}
                ><i class="codicon codicon-debug-restart"></i> {t('Retry')}</button
              >
            {/if}
          </div>
          <PipelineStages stages={pipeline.stages} number={card.iid} />
        </div>
      {:else}
        <div class="section muted">{github ? t('No checks') : t('No pipeline')}</div>
      {/if}

      {#if card.discussions}
        {@const d = card.discussions}
        {@const open = d.threads.filter((th) => !th.outdated && !(th.resolvable && th.resolved))}
        {@const rest = d.threads.filter((th) => !open.includes(th))}
        <div class="section">
          <div class="label">
            {t('Discussions')}
            <span class="muted">
              {#if d.unresolved}· {t('unresolved: {0}', d.unresolved)}{/if}
              {#if d.drafts}· {t('drafts: {0}', d.drafts)}{/if}
            </span>
            <span class="spacer"></span>
            {#if d.drafts}
              <button
                class="small"
                title={t('Publish all your drafts on this merge request (as Submit review on the web)')}
                onclick={() => post({ type: 'publishDrafts', number: card.iid })}
                ><i class="codicon codicon-cloud-upload"></i> {t('Publish drafts')}</button
              >
            {/if}
          </div>
          {#each showAll ? [...open, ...rest] : open as thread, i (i)}
            <button
              class="thread"
              class:resolved={thread.resolved}
              title={thread.outdated
                ? t('On an earlier version of the merge request')
                : t('Open in the code')}
              onclick={() =>
                post({
                  type: 'startReview',
                  number: card.iid,
                  path: thread.path,
                  line: thread.outdated ? undefined : thread.line,
                })}
            >
              <i
                class="codicon codicon-{thread.outdated
                  ? 'history'
                  : thread.resolved
                    ? 'pass'
                    : thread.resolvable
                      ? 'comment-unresolved'
                      : 'comment'}"
              ></i>
              <span class="where">{thread.path.split('/').pop()}:{thread.line}</span>
              <span class="what"><b>{thread.author}:</b> {thread.body}</span>
              {#if thread.replies}<span class="muted">+{thread.replies}</span>{/if}
            </button>
          {/each}
          {#if rest.length}
            <button class="more" onclick={() => (showAll = !showAll)}>
              {showAll ? t('Hide resolved and outdated') : t('{0} more: resolved and outdated', rest.length)}
            </button>
          {/if}
          {#each d.general as note, i (i)}
            <div class="note" class:draft={note.draft}>
              <div class="note-head">
                <b>{note.author}</b>
                <span class="muted">{note.draft ? t('draft') : formatTime(note.createdAt)}</span>
              </div>
              <div
                class="note-body"
                class:clamped={!expandedNotes.has(i)}
                role="button"
                tabindex="-1"
                title={expandedNotes.has(i) ? '' : t('Show all')}
                onclick={() => (expandedNotes = new Set([...expandedNotes, i]))}
                onkeydown={() => {}}
              >
                {note.body}
              </div>
            </div>
          {/each}
          <textarea
            placeholder={github
              ? t('Comment on the whole pull request')
              : t('Comment on the whole merge request')}
            bind:value={comment}
            onkeydown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(false);
            }}></textarea>
          <div class="comment-actions">
            <button class="small" disabled={!comment.trim()} onclick={() => send(false)}
              >{t('Publish')}</button
            >
            {#if !github}
              <button
                class="small"
                disabled={!comment.trim()}
                title={t('Save as a draft in GitLab')}
                onclick={() => send(true)}>{t('Save draft')}</button
              >
            {/if}
          </div>
        </div>
      {/if}

      <div class="actions">
        <button
          class="primary"
          title={github
            ? t('The changes of the pull request in the diff viewer; comments in the code stay on GitHub')
            : ''}
          onclick={() => post({ type: 'startReview', number: card.iid })}
          ><i class="codicon codicon-eye"></i> {card.reviewing ? t('Review is open') : t('Review')}</button
        >
        {#if card.state === 'opened' && !(github && card.approvedByMe)}
          <button
            title={card.approvedByMe ? t('Remove your approval') : t('Approve')}
            onclick={() =>
              post({ type: 'approveMergeRequest', number: card.iid, approve: !card.approvedByMe })}
            ><i class="codicon codicon-{card.approvedByMe ? 'circle-slash' : 'pass'}"></i>
            {card.approvedByMe ? t('Unapprove') : t('Approve')}</button
          >
        {/if}
        {#if card.state === 'opened'}
          {#if card.mergeStatus === 'need_rebase'}
            <button
              title={t('Rebase the branch on the GitLab server')}
              onclick={() => post({ type: 'rebaseMergeRequest', number: card.iid })}
              ><i class="codicon codicon-git-compare"></i> Rebase</button
            >
          {:else if card.mergeStatus === 'behind'}
            <button
              title={t('Bring the target branch into the pull request on GitHub')}
              onclick={() => post({ type: 'rebaseMergeRequest', number: card.iid })}
              ><i class="codicon codicon-git-compare"></i> {t('Update branch')}</button
            >
          {/if}
          <button
            title={t('Merge, after a confirmation')}
            onclick={() => post({ type: 'mergeMergeRequest', number: card.iid })}
            ><i class="codicon codicon-git-merge"></i> {t('Merge…')}</button
          >
        {/if}
        <a class="button" href={card.webUrl}
          ><i class="codicon codicon-link-external"></i> {t('Open in {0}', service)}</a
        >
      </div>
    {/if}
  </div>
{/if}

<style>
  .card {
    position: fixed;
    top: 38px;
    right: 12px;
    z-index: 60;
    width: min(440px, calc(100vw - 24px));
    max-height: calc(100vh - 50px);
    overflow: auto;
    padding: 10px 12px 12px;
    background: var(--vscode-editorWidget-background, var(--vscode-menu-background));
    color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border));
    border-radius: 6px;
    box-shadow: 0 4px 16px var(--vscode-widget-shadow);
    user-select: text;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .number {
    font-weight: 600;
  }
  .state {
    padding: 0 6px;
    border-radius: 8px;
    font-size: 0.9em;
  }
  .state.opened {
    background: color-mix(in srgb, var(--vscode-charts-green) 25%, transparent);
  }
  .state.draft {
    background: color-mix(in srgb, var(--vscode-foreground) 15%, transparent);
  }
  .state.merged {
    background: color-mix(in srgb, var(--vscode-charts-purple) 30%, transparent);
  }
  .state.closed {
    background: color-mix(in srgb, var(--vscode-charts-red) 25%, transparent);
  }
  .spacer {
    flex: 1;
  }
  .icon {
    display: inline-flex;
    padding: 2px;
    border: none;
    border-radius: 4px;
    background: none;
    color: inherit;
    cursor: pointer;
  }
  .icon:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .title {
    display: block;
    margin-bottom: 4px;
    font-weight: 600;
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }
  a {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
  .muted {
    opacity: 0.7;
  }
  .error {
    color: var(--vscode-errorForeground);
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 8px 0;
  }
  .fact {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .fact.warn {
    color: var(--vscode-editorWarning-foreground);
  }
  .section {
    margin-top: 10px;
  }
  .label {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 4px;
    font-weight: 600;
  }
  .person {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 1px 0;
  }
  .person.approved .codicon {
    color: var(--vscode-charts-green);
  }
  .status.ok {
    color: var(--vscode-charts-green);
  }
  .status.bad {
    color: var(--vscode-charts-red);
  }
  .status.run {
    color: var(--vscode-charts-blue);
  }
  .status.idle {
    opacity: 0.6;
  }
  .thread {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 2px 4px;
    border: none;
    border-radius: 3px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .thread:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .more {
    padding: 2px 4px;
    border: none;
    background: none;
    color: var(--vscode-textLink-foreground);
    font: inherit;
    cursor: pointer;
  }
  .thread.resolved {
    opacity: 0.6;
  }
  .where {
    flex: none;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.92em;
  }
  .what {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    margin: 6px 0;
    padding: 4px 6px;
    border-left: 2px solid var(--vscode-widget-border);
  }
  .note.draft {
    border-left-color: var(--vscode-charts-orange);
  }
  .note-head {
    display: flex;
    gap: 6px;
  }
  .note-body {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .note-body.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
    cursor: pointer;
  }
  textarea {
    width: 100%;
    min-height: 54px;
    margin-top: 6px;
    resize: vertical;
    padding: 4px 6px;
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font: inherit;
    outline: none;
  }
  textarea:focus {
    border-color: var(--vscode-focusBorder);
  }
  .comment-actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .comment-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .actions {
    flex-wrap: wrap;
    display: flex;
    gap: 6px;
    margin-top: 12px;
  }
  .actions button,
  .button,
  .small {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .small {
    padding: 1px 6px;
    font-weight: normal;
  }
  .actions .primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
</style>
