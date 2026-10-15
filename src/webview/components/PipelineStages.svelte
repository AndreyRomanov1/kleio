<script lang="ts">
  import { t } from '../../shared/l10n';
  import type { PipelineJobView, PipelineStageView } from '../../shared/protocol';
  import { formatDuration, pipelineIcons, statusWord } from '../hostingView';
  import { post } from '../vscode';
  import PipelineStages from './PipelineStages.svelte';

  interface Props {
    stages: PipelineStageView[];
    /** The merge request the pipeline belongs to, to refresh its card after starting a job. */
    number: number;
  }

  let { stages, number }: Props = $props();
  let expanded = $state<ReadonlySet<number>>(new Set());

  function toggle(id: number): void {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function click(job: PipelineJobView): void {
    if (job.webUrl) post({ type: 'openUrl', url: job.webUrl });
    else if (job.child) toggle(job.id);
    else if (job.status === 'manual') {
      post({ type: 'playJob', jobId: job.id, name: job.name, projectId: job.projectId, number });
    } else if (!job.bridge) {
      post({ type: 'openJobLog', jobId: job.id, name: job.name, projectId: job.projectId });
    }
  }

  function title(job: PipelineJobView): string {
    const state = job.bridge
      ? t('child pipeline {0}', statusWord(job.status))
      : t('job {0}', statusWord(job.status));
    const action = job.child
      ? expanded.has(job.id)
        ? t('collapse the child pipeline')
        : t('expand the child pipeline')
      : job.webUrl
        ? t('open the page of the check')
        : job.status === 'manual'
          ? t('run')
          : job.bridge
            ? t('not started yet')
            : t('open the log');
    return `${job.name}: ${state}${job.allowFailure ? t(' (allowed to fail)') : ''} — ${action}`;
  }
</script>

{#each stages as stage (stage.name)}
  <div class="stage">
    <span class="stage-name" title={stage.name}>{stage.name}</span>
    <div class="jobs">
      {#each stage.jobs as job (`${job.id}:${job.name}`)}
        {@const icon = pipelineIcons[job.status]}
        <button
          class="job {icon.tone}"
          class:bridge={job.bridge}
          class:allowed={job.allowFailure && job.status === 'failed'}
          title={title(job)}
          onclick={() => click(job)}
        >
          <i class="codicon codicon-{job.status === 'manual' ? 'play' : icon.icon}"></i>{job.name}
          {#if job.duration !== undefined}<span class="muted">{formatDuration(job.duration)}</span>{/if}
          {#if job.child}<i class="codicon codicon-chevron-{expanded.has(job.id) ? 'up' : 'down'}"></i>{/if}
        </button>
      {/each}
    </div>
  </div>
  {#each stage.jobs.filter((j) => j.child && expanded.has(j.id)) as job (job.id)}
    <div class="child">
      <div class="child-head">
        <i class="codicon codicon-type-hierarchy-sub"></i>
        <a href={job.child!.webUrl}>{job.name}</a>
        <span class="muted">{t('child pipeline {0}', statusWord(job.child!.status))}</span>
      </div>
      {#if job.child!.stages.length}
        <PipelineStages stages={job.child!.stages} {number} />
      {:else}
        <div class="muted">{t('no jobs')}</div>
      {/if}
    </div>
  {/each}
{/each}

<style>
  .stage {
    display: flex;
    gap: 8px;
    padding: 3px 0;
  }
  .stage-name {
    flex: none;
    width: 70px;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.7;
  }
  .jobs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .job {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 6px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 10px;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.92em;
    cursor: pointer;
  }
  .job.bridge {
    border-style: dashed;
  }
  .job:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .ok .codicon:first-child {
    color: var(--vscode-charts-green);
  }
  .bad .codicon:first-child {
    color: var(--vscode-charts-red);
  }
  .job.allowed .codicon:first-child {
    color: var(--vscode-charts-orange);
  }
  .run .codicon:first-child {
    color: var(--vscode-charts-blue);
  }
  .idle .codicon:first-child {
    opacity: 0.6;
  }
  .child {
    margin: 2px 0 6px 18px;
    padding-left: 8px;
    border-left: 2px solid var(--vscode-widget-border);
  }
  .child-head {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 2px;
  }
  .muted {
    opacity: 0.7;
  }
  a {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
</style>
