<script lang="ts">
  import type { OperationState } from '../../shared/model';
  import type { LogStore } from '../store.svelte';
  import { post } from '../vscode';
  import { t } from '../../shared/l10n';

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
          operation.step && operation.total ? t(' · step {0} of {1}', operation.step, operation.total) : '';
        return t('Rebasing {0} onto {1}', operation.branch ?? 'HEAD', target) + step;
      }
      case 'merge':
        return current ? t('Merging {0} into {1}', target, current) : t('Merging {0}', target);
      case 'cherry-pick':
        return t('Cherry-picking {0}', target);
      case 'revert':
        return t('Reverting {0}', target);
    }
  });

  const conflicts = $derived(operation.conflicted.length);
  const canSkip = $derived(operation.kind === 'rebase' || operation.kind === 'cherry-pick');
</script>

<div class="banner" class:conflicts={conflicts > 0} role="status">
  <i class="codicon codicon-{conflicts ? 'warning' : 'debug-pause'}"></i>
  <span class="text">{text}</span>
  {#if conflicts}
    <span class="detail">· {t('conflicts: {0}', conflicts)}</span>
  {:else if operation.stoppedAt}
    <span class="detail">· {t('stopped at {0}', operation.stoppedAt.slice(0, 8))}</span>
  {/if}
  <span class="spacer"></span>
  {#if conflicts}
    <button class="primary" onclick={() => post({ type: 'operation', action: 'resolve' })}
      >{t('Resolve conflicts')}</button
    >
  {/if}
  <button
    class:primary={!conflicts}
    title="git {operation.kind} --continue"
    onclick={() => post({ type: 'operation', action: 'continue' })}>{t('Continue')}</button
  >
  {#if canSkip}
    <button
      title={t('Skip the current commit: git {0} --skip', operation.kind)}
      onclick={() => post({ type: 'operation', action: 'skip' })}>{t('Skip')}</button
    >
  {/if}
  <button
    title={t('Return everything to where it was before: git {0} --abort', operation.kind)}
    onclick={() => post({ type: 'operation', action: 'abort' })}>{t('Abort')}</button
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
