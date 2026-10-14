/** Removes terminal colours and GitLab's collapsible section markers from a job log. */
export function cleanLog(text: string): string {
  return text
    .replace(/section_(?:start|end):\d+:[^\r\n]*?\r?\x1b\[0K/g, '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r(?!\n)/g, '\n');
}
