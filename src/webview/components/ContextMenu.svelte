<script lang="ts">
  import { menu, type MenuItem } from '../menu.svelte';

  let element: HTMLDivElement | undefined = $state();
  let left = $state(0);
  let top = $state(0);

  $effect(() => {
    if (!menu.open || !element) return;
    const rect = element.getBoundingClientRect();
    left = Math.min(menu.x, window.innerWidth - rect.width - 4);
    top = Math.min(menu.y, window.innerHeight - rect.height - 4);
    element.focus();
  });

  function choose(item: MenuItem): void {
    if (item.disabled) return;
    menu.close();
    item.run();
  }
</script>

<svelte:window
  onmousedown={(e) => {
    if (menu.open && element && !element.contains(e.target as Node)) menu.close();
  }}
  onblur={() => menu.close()}
  onresize={() => menu.close()}
/>

{#if menu.open}
  <div
    class="menu"
    role="menu"
    tabindex="-1"
    bind:this={element}
    style:left="{left}px"
    style:top="{top}px"
    onkeydown={(e) => {
      if (e.key === 'Escape') menu.close();
    }}
  >
    {#each menu.entries as entry, i (i)}
      {#if entry === 'separator'}
        <div class="separator"></div>
      {:else}
        <button class="item" role="menuitem" disabled={entry.disabled} onclick={() => choose(entry)}>
          <span>{entry.label}</span>
          {#if entry.hint}<span class="hint">{entry.hint}</span>{/if}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 100;
    min-width: 200px;
    padding: 4px 0;
    background: var(--vscode-menu-background);
    color: var(--vscode-menu-foreground);
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));
    border-radius: 5px;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow);
    outline: none;
  }
  .item {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    width: 100%;
    padding: 3px 14px;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .item:hover:not(:disabled) {
    background: var(--vscode-menu-selectionBackground);
    color: var(--vscode-menu-selectionForeground);
  }
  .item:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .hint {
    opacity: 0.6;
  }
  .separator {
    height: 1px;
    margin: 4px 0;
    background: var(--vscode-menu-separatorBackground, var(--vscode-widget-border));
  }
</style>
