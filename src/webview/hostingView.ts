import type { MergeRequestInfoView, PipelineStatusView } from '../shared/protocol';

export const pipelineIcons: Record<PipelineStatusView, { icon: string; label: string; tone: string }> = {
  success: { icon: 'pass-filled', label: 'пайплайн прошёл', tone: 'ok' },
  failed: { icon: 'error', label: 'пайплайн упал', tone: 'bad' },
  running: { icon: 'sync~spin', label: 'пайплайн идёт', tone: 'run' },
  pending: { icon: 'clock', label: 'пайплайн ждёт', tone: 'run' },
  created: { icon: 'clock', label: 'пайплайн создан', tone: 'run' },
  preparing: { icon: 'clock', label: 'пайплайн готовится', tone: 'run' },
  waiting_for_resource: { icon: 'clock', label: 'пайплайн ждёт ресурс', tone: 'run' },
  scheduled: { icon: 'calendar', label: 'пайплайн запланирован', tone: 'run' },
  manual: { icon: 'debug-pause', label: 'ждёт ручного запуска', tone: 'idle' },
  canceled: { icon: 'circle-slash', label: 'пайплайн отменён', tone: 'idle' },
  skipped: { icon: 'debug-step-over', label: 'пайплайн пропущен', tone: 'idle' },
};

export function mergeRequestStateLabel(info: MergeRequestInfoView | undefined): string | undefined {
  if (!info) return undefined;
  if (info.state === 'merged') return 'влит';
  if (info.state === 'closed' || info.state === 'locked') return 'закрыт';
  return info.draft ? 'черновик' : 'открыт';
}

/** CSS modifier of a merge request badge: colour by state. */
export function mergeRequestTone(info: MergeRequestInfoView | undefined): string {
  if (!info) return '';
  if (info.state === 'merged') return 'merged';
  if (info.state === 'closed' || info.state === 'locked') return 'closed';
  return info.draft ? 'draft' : 'opened';
}

const mergeStatuses: Record<string, string> = {
  mergeable: 'можно вливать',
  can_be_merged: 'можно вливать',
  not_approved: 'нужны аппрувы',
  ci_still_running: 'ждёт пайплайн',
  ci_must_pass: 'нужен зелёный пайплайн',
  discussions_not_resolved: 'есть нерешённые обсуждения',
  draft_status: 'черновик',
  need_rebase: 'нужен rebase',
  conflict: 'конфликты',
  cannot_be_merged: 'конфликты',
  blocked_status: 'заблокирован другим MR',
  checking: 'проверяется',
  unchecked: 'проверяется',
  not_open: 'не открыт',
};

export function mergeStatusLabel(status: string | undefined): string | undefined {
  return status ? (mergeStatuses[status] ?? status) : undefined;
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}м ${total % 60}с` : `${total}с`;
}
