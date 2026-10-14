<script lang="ts">
  import { linkify, type LinkRule } from '../../shared/linkify';
  import { post } from '../vscode';

  interface Props {
    text: string;
    rules: readonly LinkRule[];
  }

  let { text, rules }: Props = $props();
  const parts = $derived(linkify(text, rules));
</script>

{#each parts as part, i (i)}{#if part.url}<a
      href={part.url}
      title={part.url}
      onclick={(e) => {
        e.preventDefault();
        post({ type: 'openUrl', url: part.url! });
      }}>{part.text}</a
    >{:else}{part.text}{/if}{/each}

<style>
  a {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
</style>
