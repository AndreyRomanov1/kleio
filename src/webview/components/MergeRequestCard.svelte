<script lang="ts">
  import { mergeRequestStateLabel, mergeRequestTone, mergeStatusLabel, pipelineIcons } from '../hostingView';
  import type { LogStore } from '../store.svelte';
  import { post } from '../vscode';
  import PipelineStages from './PipelineStages.svelte';

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

  const timeFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  function formatTime(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date);
  }

  const current = $derived(store.card);
  const card = $derived(current?.card);
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
  <div class="card" bind:this={element} role="dialog" aria-label="Merge request !{current.number}">
    <div class="head">
      <span class="number">!{current.number}</span>
      {#if card}
        <span class="state {mergeRequestTone(card)}">{mergeRequestStateLabel(card)}</span>
      {/if}
      <span class="spacer"></span>
      <button class="icon" title="Обновить" onclick={() => store.openCard(current.number)}
        ><i class="codicon codicon-refresh"></i></button
      >
      <button class="icon" title="Закрыть (Esc)" onclick={() => store.closeCard()}
        ><i class="codicon codicon-close"></i></button
      >
    </div>

    {#if current.loading && !card}
      <div class="muted"><i class="codicon codicon-loading codicon-modifier-spin"></i> Загрузка…</div>
    {:else if current.needsAuth}
      <p>Чтобы показать детали MR и пайплайн, Grove нужен доступ к GitLab.</p>
      <p class="muted">
        Если стоит расширение GitLab Workflow с аккаунтом этого сервера, Grove возьмёт доступ оттуда; иначе
        попросит личный токен.
      </p>
      <div class="actions">
        <button class="primary" onclick={() => post({ type: 'connectHosting', number: current.number })}
          >Подключить GitLab</button
        >
        <button onclick={() => post({ type: 'openMergeRequest', number: current.number })}
          >Открыть в браузере</button
        >
      </div>
    {:else if current.error}
      <p class="error">{current.error}</p>
      <div class="actions">
        <button onclick={() => store.openCard(current.number)}>Повторить</button>
      </div>
    {:else if card}
      <a class="title" href={card.webUrl}>{card.title}</a>
      <div class="muted">{card.author} · {card.sourceBranch} → {card.targetBranch}</div>

      <div class="facts">
        {#if mergeStatusLabel(card.mergeStatus) && card.state === 'opened'}
          <span class="fact" class:warn={card.mergeStatus !== 'mergeable'}
            ><i class="codicon codicon-git-merge"></i>{mergeStatusLabel(card.mergeStatus)}</span
          >
        {/if}
        {#if card.hasConflicts}<span class="fact warn"><i class="codicon codicon-warning"></i>конфликты</span
          >{/if}
        <span class="fact"><i class="codicon codicon-comment"></i>{card.notes}</span>
      </div>

      <div class="section">
        <div class="label">
          Ревьюеры{#if card.approvalsLeft > 0}<span class="muted">
              · нужно ещё аппрувов: {card.approvalsLeft}</span
            >{/if}
        </div>
        {#if card.reviewers.length === 0 && card.approvedBy.length === 0}
          <div class="muted">не назначены</div>
        {/if}
        {#each card.reviewers as reviewer (reviewer.name)}
          <div class="person" class:approved={reviewer.approved}>
            <i class="codicon codicon-{reviewer.approved ? 'pass-filled' : 'circle-large-outline'}"
            ></i>{reviewer.name}
          </div>
        {/each}
        {#each card.approvedBy as name (name)}
          <div class="person approved">
            <i class="codicon codicon-pass-filled"></i>{name} <span class="muted">(не ревьюер)</span>
          </div>
        {/each}
      </div>

      {#if card.pipeline}
        {@const pipeline = card.pipeline}
        {@const icon = pipelineIcons[pipeline.status]}
        <div class="section">
          <div class="label pipeline-head">
            <span class="status {icon.tone}"><i class="codicon codicon-{icon.icon}"></i></span>
            <a href={pipeline.webUrl}>Пайплайн #{pipeline.id}</a>
            <span class="muted">{icon.label}</span>
            <span class="spacer"></span>
            {#if pipeline.status === 'failed' || pipeline.status === 'canceled'}
              <button
                class="small"
                title="Перезапустить упавшие и отменённые джобы"
                onclick={() => post({ type: 'retryPipeline', pipelineId: pipeline.id, number: card.iid })}
                ><i class="codicon codicon-debug-restart"></i> Перезапустить</button
              >
            {/if}
          </div>
          <PipelineStages stages={pipeline.stages} />
        </div>
      {:else}
        <div class="section muted">Пайплайна нет</div>
      {/if}

      {#if card.discussions}
        {@const d = card.discussions}
        {@const open = d.threads.filter((t) => !t.outdated && !(t.resolvable && t.resolved))}
        {@const rest = d.threads.filter((t) => !open.includes(t))}
        <div class="section">
          <div class="label">
            Обсуждения
            <span class="muted">
              {#if d.unresolved}· нерешённых {d.unresolved}{/if}
              {#if d.drafts}· черновиков {d.drafts}{/if}
            </span>
            <span class="spacer"></span>
            {#if d.drafts}
              <button
                class="small"
                title="Опубликовать все ваши черновики к этому MR (как Submit review на вебе)"
                onclick={() => post({ type: 'publishDrafts', number: card.iid })}
                ><i class="codicon codicon-cloud-upload"></i> Опубликовать черновики</button
              >
            {/if}
          </div>
          {#each showAll ? [...open, ...rest] : open as thread, i (i)}
            <button
              class="thread"
              class:resolved={thread.resolved}
              title={thread.outdated ? 'К прошлой версии MR' : 'Открыть в коде'}
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
              {showAll
                ? 'Скрыть решённые и к прошлым версиям'
                : `Ещё ${rest.length}: решённые и к прошлым версиям`}
            </button>
          {/if}
          {#each d.general as note, i (i)}
            <div class="note" class:draft={note.draft}>
              <div class="note-head">
                <b>{note.author}</b>
                <span class="muted">{note.draft ? 'черновик' : formatTime(note.createdAt)}</span>
              </div>
              <div
                class="note-body"
                class:clamped={!expandedNotes.has(i)}
                role="button"
                tabindex="-1"
                title={expandedNotes.has(i) ? '' : 'Показать целиком'}
                onclick={() => (expandedNotes = new Set([...expandedNotes, i]))}
                onkeydown={() => {}}
              >
                {note.body}
              </div>
            </div>
          {/each}
          <textarea
            placeholder="Комментарий ко всему MR"
            bind:value={comment}
            onkeydown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(false);
            }}></textarea>
          <div class="comment-actions">
            <button class="small" disabled={!comment.trim()} onclick={() => send(false)}>Опубликовать</button>
            <button
              class="small"
              disabled={!comment.trim()}
              title="Сохранить черновиком в GitLab"
              onclick={() => send(true)}>В черновик</button
            >
          </div>
        </div>
      {/if}

      <div class="actions">
        <button class="primary" onclick={() => post({ type: 'startReview', number: card.iid })}
          ><i class="codicon codicon-eye"></i> {card.reviewing ? 'Ревью открыто' : 'Ревью'}</button
        >
        <a class="button" href={card.webUrl}><i class="codicon codicon-link-external"></i> Открыть в GitLab</a
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
