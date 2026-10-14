const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const full = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'medium' });

/** Rider-like compact date: "Сегодня 14:05", "Вчера 09:12", "03.10.2026 18:40". */
export function formatDate(unixSeconds: number, now = new Date()): string {
  const value = new Date(unixSeconds * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (value.getTime() >= startOfToday) return `Сегодня ${time.format(value)}`;
  if (value.getTime() >= startOfToday - day) return `Вчера ${time.format(value)}`;
  return `${date.format(value)} ${time.format(value)}`;
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
