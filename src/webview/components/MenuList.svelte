<script lang="ts">
  import { menu, type MenuEntry, type MenuItem } from '../menu.svelte';
  import MenuList from './MenuList.svelte';

  interface Props {
    entries: MenuEntry[];
    x: number;
    y: number;
    /** Left edge of the parent item, to flip a submenu to the left when it does not fit. */
    flipX?: number;
  }

  let { entries, x, y, flipX }: Props = $props();

  let element: HTMLDivElement | undefined = $state();
  let left = $state(0);
  let top = $state(0);
  let open = $state<{ index: number; x: number; y: number; flipX: number } | undefined>(undefined);

  $effect(() => {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const fitsRight = x + rect.width <= window.innerWidth - 4;
    left = fitsRight ? x : Math.max(4, (flipX ?? x) - rect.width);
    top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  });

  function choose(item: MenuItem): void {
    if (item.disabled || item.submenu) return;
    menu.close();
    item.run?.();
  }

  function hover(event: MouseEvent, item: MenuItem, index: number): void {
    if (!item.submenu || item.disabled) {
      open = undefined;
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    open = { index, x: rect.right - 2, y: rect.top - 4, flipX: rect.left + 2 };
  }
</script>

<div class="menu" role="menu" tabindex="-1" bind:this={element} style:left="{left}px" style:top="{top}px">
  {#each entries as entry, i (i)}
    {#if entry === 'separator'}
      <div class="separator"></div>
    {:else}
      <button
        class="item"
        class:active={open?.index === i}
        role="menuitem"
        disabled={entry.disabled}
        onclick={() => choose(entry)}
        onmouseenter={(e) => hover(e, entry, i)}
      >
        <span class="icon"
          >{#if entry.icon}<i class="codicon codicon-{entry.icon}"></i>{/if}</span
        >
        <span class="label">{entry.label}</span>
        {#if entry.hint}<span class="hint">{entry.hint}</span>{/if}
        {#if entry.submenu}<i class="codicon codicon-chevron-right arrow"></i>{/if}
      </button>
    {/if}
  {/each}
</div>
{#if open}
  {@const item = entries[open.index]}
  {#if item !== 'separator' && item.submenu}
    <MenuList entries={item.submenu} x={open.x} y={open.y} flipX={open.flipX} />
  {/if}
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 100;
    min-width: 200px;
    max-width: 420px;
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
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 10px 3px 6px;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .item:hover:not(:disabled),
  .item.active {
    background: var(--vscode-menu-selectionBackground);
    color: var(--vscode-menu-selectionForeground);
  }
  .item:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .icon {
    flex: none;
    width: 16px;
    display: inline-flex;
    justify-content: center;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    margin-left: 18px;
    opacity: 0.6;
  }
  .arrow {
    margin-left: 12px;
  }
  .separator {
    height: 1px;
    margin: 4px 0;
    background: var(--vscode-menu-separatorBackground, var(--vscode-widget-border));
  }
</style>
