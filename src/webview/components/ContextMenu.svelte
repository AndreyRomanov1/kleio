<script lang="ts">
  import { menu } from '../menu.svelte';
  import MenuList from './MenuList.svelte';

  let root: HTMLDivElement | undefined = $state();
</script>

<svelte:window
  onmousedown={(e) => {
    if (menu.open && root && !root.contains(e.target as Node)) menu.close();
  }}
  onkeydown={(e) => {
    if (menu.open && e.key === 'Escape') menu.close();
  }}
  onblur={() => menu.close()}
  onresize={() => menu.close()}
/>

{#if menu.open}
  <div bind:this={root}>
    {#key menu.entries}
      <MenuList entries={menu.entries} x={menu.x} y={menu.y} />
    {/key}
  </div>
{/if}
