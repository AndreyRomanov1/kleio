<script lang="ts">
  interface Props {
    state: 'all' | 'some' | 'none';
    label: string;
    onchange: (value: boolean) => void;
  }

  let { state, label, onchange }: Props = $props();
</script>

<span
  class="check {state}"
  role="checkbox"
  tabindex="-1"
  aria-label={label}
  aria-checked={state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}
  onclick={(e) => {
    e.stopPropagation();
    onchange(state !== 'all');
  }}
  onkeydown={(e) => {
    if (e.key === ' ') {
      e.preventDefault();
      onchange(state !== 'all');
    }
  }}
  ondblclick={(e) => e.stopPropagation()}
>
  {#if state === 'all'}<i class="codicon codicon-check"></i>{:else if state === 'some'}<i
      class="codicon codicon-dash"
    ></i>{/if}
</span>

<style>
  .check {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border: 1px solid var(--vscode-checkbox-border, var(--vscode-widget-border));
    border-radius: 3px;
    background: var(--vscode-checkbox-background, transparent);
    color: var(--vscode-checkbox-foreground, inherit);
    cursor: pointer;
  }
  .check .codicon {
    font-size: 12px;
  }
  .check.all,
  .check.some {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
</style>
