<script lang="ts">
  import type { GraphRow, Segment } from '../../shared/graph';

  interface Props {
    row: GraphRow;
    lanes: number;
    height: number;
    isHead: boolean;
    isMerge: boolean;
    dotOnly: boolean;
  }

  let { row, lanes, height, isHead, isMerge, dotOnly }: Props = $props();

  const LANE = 14;
  const x = (lane: number) => lane * LANE + LANE / 2;

  function segmentPath(s: Segment): string {
    const x1 = x(s.x1);
    const x2 = x(s.x2);
    const y1 = s.y1 * height;
    const y2 = s.y2 * height;
    if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`;
    const middle = (y1 + y2) / 2;
    return `M${x1} ${y1}C${x1} ${middle} ${x2} ${middle} ${x2} ${y2}`;
  }

  const width = $derived(dotOnly ? LANE : Math.max(1, lanes) * LANE);
  const nodeX = $derived(dotOnly ? LANE / 2 : x(row.lane));
  const visibleSegments = $derived(dotOnly ? [] : row.segments.filter((s) => s.x1 < lanes && s.x2 < lanes));
</script>

<svg class="graph" {width} {height} aria-hidden="true">
  {#each visibleSegments as segment, i (i)}
    <path d={segmentPath(segment)} class="line c{segment.color % 8}" />
  {/each}
  {#if row.lane < lanes || dotOnly}
    <circle
      cx={nodeX}
      cy={height / 2}
      r={isHead ? 5 : 4}
      class="node c{row.color % 8}"
      class:merge={isMerge}
      class:head={isHead}
    />
  {/if}
</svg>

<style>
  .graph {
    flex: none;
    overflow: visible;
  }
  .line {
    fill: none;
    stroke-width: 2;
  }
  .node {
    stroke-width: 2;
  }
  .node.merge {
    fill: var(--vscode-editor-background);
  }
  .node.head {
    stroke: var(--vscode-editor-foreground);
  }
  .c0 {
    stroke: var(--g0);
  }
  .node.c0:not(.merge) {
    fill: var(--g0);
  }
  .c1 {
    stroke: var(--g1);
  }
  .node.c1:not(.merge) {
    fill: var(--g1);
  }
  .c2 {
    stroke: var(--g2);
  }
  .node.c2:not(.merge) {
    fill: var(--g2);
  }
  .c3 {
    stroke: var(--g3);
  }
  .node.c3:not(.merge) {
    fill: var(--g3);
  }
  .c4 {
    stroke: var(--g4);
  }
  .node.c4:not(.merge) {
    fill: var(--g4);
  }
  .c5 {
    stroke: var(--g5);
  }
  .node.c5:not(.merge) {
    fill: var(--g5);
  }
  .c6 {
    stroke: var(--g6);
  }
  .node.c6:not(.merge) {
    fill: var(--g6);
  }
  .c7 {
    stroke: var(--g7);
  }
  .node.c7:not(.merge) {
    fill: var(--g7);
  }
  .node.head.c0,
  .node.head.c1,
  .node.head.c2,
  .node.head.c3,
  .node.head.c4,
  .node.head.c5,
  .node.head.c6,
  .node.head.c7 {
    stroke: var(--vscode-editor-foreground);
  }
</style>
