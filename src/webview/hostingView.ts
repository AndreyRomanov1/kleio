import type { MergeRequestInfoView, PipelineStatusView } from '../shared/protocol';
import { t } from '../shared/l10n';

export const pipelineIcons: Record<PipelineStatusView, { icon: string; label: string; tone: string }> = {
  success: { icon: 'pass-filled', label: t('pipeline passed'), tone: 'ok' },
  failed: { icon: 'error', label: t('pipeline failed'), tone: 'bad' },
  running: { icon: 'sync~spin', label: t('pipeline running'), tone: 'run' },
  pending: { icon: 'clock', label: t('pipeline pending'), tone: 'run' },
  created: { icon: 'clock', label: t('pipeline created'), tone: 'run' },
  preparing: { icon: 'clock', label: t('pipeline preparing'), tone: 'run' },
  waiting_for_resource: { icon: 'clock', label: t('pipeline waiting for a resource'), tone: 'run' },
  scheduled: { icon: 'calendar', label: t('pipeline scheduled'), tone: 'run' },
  manual: { icon: 'debug-pause', label: t('waiting for a manual run'), tone: 'idle' },
  canceled: { icon: 'circle-slash', label: t('pipeline canceled'), tone: 'idle' },
  skipped: { icon: 'debug-step-over', label: t('pipeline skipped'), tone: 'idle' },
};

const statusWords: Record<PipelineStatusView, string> = {
  success: t('passed'),
  failed: t('failed'),
  running: t('running'),
  pending: t('pending'),
  created: t('created'),
  preparing: t('preparing'),
  waiting_for_resource: t('waiting for a resource'),
  scheduled: t('scheduled'),
  manual: t('waiting for a manual run'),
  canceled: t('canceled'),
  skipped: t('skipped'),
};

/** The status alone, e.g. for a job: "failed". */
export function statusWord(status: PipelineStatusView): string {
  return statusWords[status];
}

export function mergeRequestStateLabel(info: MergeRequestInfoView | undefined): string | undefined {
  if (!info) return undefined;
  if (info.state === 'merged') return t('merged');
  if (info.state === 'closed' || info.state === 'locked') return t('closed');
  return info.draft ? t('draft') : t('open');
}

/** CSS modifier of a merge request badge: colour by state. */
export function mergeRequestTone(info: MergeRequestInfoView | undefined): string {
  if (!info) return '';
  if (info.state === 'merged') return 'merged';
  if (info.state === 'closed' || info.state === 'locked') return 'closed';
  return info.draft ? 'draft' : 'opened';
}

const mergeStatuses: Record<string, string> = {
  mergeable: t('can be merged'),
  can_be_merged: t('can be merged'),
  not_approved: t('needs approvals'),
  ci_still_running: t('waiting for the pipeline'),
  ci_must_pass: t('needs a green pipeline'),
  discussions_not_resolved: t('has unresolved discussions'),
  draft_status: t('draft'),
  need_rebase: t('needs a rebase'),
  conflict: t('conflicts'),
  cannot_be_merged: t('conflicts'),
  blocked_status: t('blocked by another merge request'),
  checking: t('checking'),
  unchecked: t('checking'),
  not_open: t('not open'),
  // GitHub
  clean: t('can be merged'),
  has_hooks: t('can be merged'),
  unstable: t('can be merged, checks are failing'),
  blocked: t('blocked: reviews or checks are missing'),
  behind: t('behind the target branch'),
  dirty: t('conflicts'),
  draft: t('draft'),
  unknown: t('checking'),
};

/** `#12` for a GitHub pull request, `!12` for a GitLab merge request. */
export function mergeRequestRef(hosting: { kind?: string } | undefined, number: number): string {
  return `${hosting?.kind === 'github' ? '#' : '!'}${number}`;
}

/** Whether the merge status says the merge request can be merged as it is. */
export function mergeReady(status: string | undefined): boolean {
  return ['mergeable', 'can_be_merged', 'clean', 'has_hooks'].includes(status ?? '');
}

export function mergeStatusLabel(status: string | undefined): string | undefined {
  return status ? (mergeStatuses[status] ?? status) : undefined;
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return minutes ? t('{0}m {1}s', minutes, total % 60) : t('{0}s', total);
}
