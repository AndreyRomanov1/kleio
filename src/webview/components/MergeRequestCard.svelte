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

      <div class="actions">
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
