import { t } from '../shared/l10n';

/** The display language of the editor, set on the page by the extension. */
export const locale = document.documentElement.lang || undefined;

const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayMonth = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' });
const dayMonthYear = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
const full = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'medium' });

/** Compact date: "Today 14:05", "Yesterday 09:12", then the day and month, with the year for past years. */
export function formatDate(unixSeconds: number, now = new Date()): string {
  const value = new Date(unixSeconds * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (value.getTime() >= startOfToday) return t('Today {0}', time.format(value));
  if (value.getTime() >= startOfToday - day) return t('Yesterday {0}', time.format(value));
  const format = value.getFullYear() === now.getFullYear() ? dayMonth : dayMonthYear;
  return `${format.format(value)} ${time.format(value)}`;
}

export function formatFullDate(unixSeconds: number): string {
  return full.format(new Date(unixSeconds * 1000));
}

export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

export function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}
