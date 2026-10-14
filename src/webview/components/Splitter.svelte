<script lang="ts">
  interface Props {
    vertical?: boolean;
    ondrag: (delta: number) => void;
    onend?: () => void;
  }

  let { vertical = false, ondrag, onend }: Props = $props();
  let last = 0;

  function down(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    last = vertical ? event.clientY : event.clientX;
  }

  function move(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    if (!target.hasPointerCapture(event.pointerId)) return;
    const position = vertical ? event.clientY : event.clientX;
    ondrag(position - last);
    last = position;
  }

  function up(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    onend?.();
  }
</script>

<div
  class="splitter"
  class:vertical
  role="separator"
  aria-orientation={vertical ? 'horizontal' : 'vertical'}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
></div>

<style>
  .splitter {
    flex: none;
    width: 4px;
    cursor: col-resize;
    background: var(--vscode-panel-border, var(--vscode-widget-border));
    background-clip: content-box;
    padding: 0 1px;
  }
  .splitter.vertical {
    width: auto;
    height: 4px;
    cursor: row-resize;
    padding: 1px 0;
  }
  .splitter:hover {
    background: var(--vscode-sash-hoverBorder);
    background-clip: border-box;
  }
</style>
