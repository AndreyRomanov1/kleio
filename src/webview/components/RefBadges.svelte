<script lang="ts">
  import type { Ref } from '../../shared/model';
  import { menu } from '../menu.svelte';
  import { refMenu } from '../menus';
  import type { Decorations, LogStore } from '../store.svelte';
  import { basename } from '../format';
  import { post } from '../vscode';

  interface Props {
    hash: string;
    decorations: Decorations | undefined;
    store: LogStore;
  }

  let { hash, decorations, store }: Props = $props();

  interface Badge {
    ref?: Ref;
    label: string;
    kind: 'head' | 'remote' | 'tag' | 'detached' | 'worktree';
    worktree?: string;
    current: boolean;
    synced: boolean;
    title: string;
  }

  const badges = $derived.by(() => {
    const head = store.snapshot?.head;
    const result: Badge[] = [];
    const refs = decorations?.refs ?? [];
    // A remote branch at the same commit as its local branch is folded into the local badge.
    const folded = new Set(
      refs
        .filter((r) => r.kind === 'head' && r.upstream && refs.some((o) => o.fullName === r.upstream))
        .map((r) => r.upstream!),
    );
    if (decorations?.isHead && !head?.branch) {
      result.push({
        label: 'HEAD',
        kind: 'detached',
        current: true,
        synced: false,
        title: 'HEAD (без ветки)',
      });
    }
    const order = { head: 0, remote: 1, tag: 2 };
    for (const ref of [...refs].sort((a, b) => order[a.kind] - order[b.kind])) {
      if (folded.has(ref.fullName)) continue;
      const current = ref.kind === 'head' && head?.branch === ref.name;
      const synced = ref.kind === 'head' && !!ref.upstream && folded.has(ref.upstream);
      const worktree =
        ref.kind === 'head'
          ? store.snapshot?.worktrees.find((w) => w.branch === ref.name && !w.isCurrent)
          : undefined;
      const notes = [
        current ? 'текущая ветка' : '',
        synced ? `= ${ref.upstream?.replace('refs/remotes/', '')}` : '',
        worktree ? `открыта в worktree ${worktree.path}` : '',
      ].filter(Boolean);
      result.push({
        ref,
        label: ref.name,
        kind: ref.kind,
        current,
        synced,
        worktree: worktree ? basename(worktree.path) : undefined,
        title: notes.length ? `${ref.name} — ${notes.join(', ')}` : ref.name,
      });
    }
    for (const worktree of (decorations?.worktrees ?? []).filter((w) => !w.branch)) {
      result.push({
        label: basename(worktree.path),
        kind: 'worktree',
        current: false,
        synced: false,
        title: `HEAD worktree ${worktree.path}`,
      });
    }
    return result;
  });
</script>

{#each badges as badge (badge.kind + badge.label)}
  <span
    class="badge {badge.kind}"
    class:current={badge.current}
    title={badge.title}
    role="note"
    oncontextmenu={(e) => {
      if (badge.ref) menu.show(e, refMenu(badge.ref, store));
    }}
  >
    {#if badge.current}<i class="marker codicon codicon-circle-filled"></i>{/if}
    {#if badge.kind === 'worktree'}<i class="marker codicon codicon-repo"></i>{/if}
    {#if badge.kind === 'tag'}<i class="marker codicon codicon-tag"></i>{/if}
    {badge.label}
    {#if badge.worktree}<i class="marker codicon codicon-repo"></i>{/if}
    {#if badge.synced}<i class="marker codicon codicon-cloud" aria-label="совпадает с origin"></i>{/if}
  </span>
{/each}
{#each store.hosting?.mergeRequests[hash] ?? [] as number (number)}
  <button
    class="badge mr"
    title="Merge request !{number} — открыть в {store.hosting?.name}"
    onmousedown={(e) => e.stopPropagation()}
    onclick={() => post({ type: 'openMergeRequest', number })}>!{number}</button
  >
{/each}

<style>
  .mr {
    font: inherit;
    font-size: 0.92em;
    color: inherit;
    cursor: pointer;
    background: color-mix(in srgb, var(--vscode-charts-orange) 22%, transparent);
    border-color: color-mix(in srgb, var(--vscode-charts-orange) 55%, transparent);
  }
  .badge {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    max-width: 220px;
    margin-right: 4px;
    padding: 0 5px;
    border-radius: 3px;
    border: 1px solid transparent;
    font-size: 0.92em;
    line-height: 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .head {
    background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 22%, transparent);
    border-color: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 55%, transparent);
  }
  .remote {
    background: color-mix(in srgb, var(--vscode-charts-purple) 18%, transparent);
    border-color: color-mix(in srgb, var(--vscode-charts-purple) 45%, transparent);
  }
  .tag {
    background: color-mix(in srgb, var(--vscode-charts-yellow) 20%, transparent);
    border-color: color-mix(in srgb, var(--vscode-charts-yellow) 50%, transparent);
  }
  .detached {
    background: color-mix(in srgb, var(--vscode-charts-orange) 25%, transparent);
    border-color: var(--vscode-charts-orange);
  }
  .worktree {
    background: color-mix(in srgb, var(--vscode-charts-blue) 18%, transparent);
    border-color: color-mix(in srgb, var(--vscode-charts-blue) 45%, transparent);
  }
  .current {
    font-weight: 600;
  }
  .marker {
    font-size: 12px !important;
    opacity: 0.85;
  }
</style>
