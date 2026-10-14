<script lang="ts">
  import type { OperationState } from '../../shared/model';
  import type { LogStore } from '../store.svelte';
  import { post } from '../vscode';

  interface Props {
    store: LogStore;
    operation: OperationState;
  }

  let { store, operation }: Props = $props();

  /** A branch pointing at the commit reads better than its hash. */
  function describe(hash: string | undefined): string {
    if (!hash) return '';
    const refs = store.decorations.get(hash)?.refs ?? [];
    const ref = refs.find((r) => r.kind === 'head') ?? refs.find((r) => r.kind === 'remote') ?? refs[0];
    return ref?.name ?? hash.slice(0, 8);
  }

  const text = $derived.by(() => {
    const target = describe(operation.onto);
    const current = store.snapshot?.head.branch;
    switch (operation.kind) {
      case 'rebase': {
        const step =
          operation.step && operation.total ? ` · шаг ${operation.step} из ${operation.total}` : '';
        return `Идёт rebase ${operation.branch ?? 'HEAD'} на ${target}${step}`;
      }
      case 'merge':
        return `Идёт merge ${target}${current ? ` в ${current}` : ''}`;
      case 'cherry-pick':
        return `Идёт cherry-pick ${target}`;
      case 'revert':
        return `Идёт revert ${target}`;
    }
  });

  const conflicts = $derived(operation.conflicted.length);
  const canSkip = $derived(operation.kind === 'rebase' || operation.kind === 'cherry-pick');
</script>

<div class="banner" class:conflicts={conflicts > 0} role="status">
  <i class="codicon codicon-{conflicts ? 'warning' : 'debug-pause'}"></i>
  <span class="text">{text}</span>
  {#if conflicts}
    <span class="detail">· конфликтов: {conflicts}</span>
  {:else if operation.stoppedAt}
    <span class="detail">· остановлен на {operation.stoppedAt.slice(0, 8)}</span>
  {/if}
  <span class="spacer"></span>
  {#if conflicts}
    <button class="primary" onclick={() => post({ type: 'operation', action: 'resolve' })}
      >Разрешить конфликты</button
    >
  {/if}
  <button
    class:primary={!conflicts}
    title="git {operation.kind} --continue"
    onclick={() => post({ type: 'operation', action: 'continue' })}>Продолжить</button
  >
  {#if canSkip}
    <button
      title="Пропустить текущий коммит: git {operation.kind} --skip"
      onclick={() => post({ type: 'operation', action: 'skip' })}>Пропустить</button
    >
  {/if}
  <button
    title="Вернуть всё как было до начала: git {operation.kind} --abort"
    onclick={() => post({ type: 'operation', action: 'abort' })}>Прервать</button
  >
</div>

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-inputValidation-infoBackground, var(--vscode-editorWidget-background));
    flex-wrap: wrap;
  }
  .banner.conflicts {
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background));
  }
  .banner.conflicts .codicon {
    color: var(--vscode-charts-orange);
  }
  .text {
    font-weight: 600;
  }
  .detail {
    color: var(--vscode-descriptionForeground);
  }
  .spacer {
    flex: 1;
  }
  button {
    padding: 2px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    font: inherit;
    cursor: pointer;
  }
  button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
</style>
