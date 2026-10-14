export interface LinkRule {
  pattern: string;
  url: string;
}

export interface TextPart {
  text: string;
  url?: string;
}

/**
 * Splits text into plain parts and links found by the rules. Where rules overlap, the earliest match wins, then
 * the rule listed first. Rules with invalid patterns are skipped, as they come from user settings.
 */
export function linkify(text: string, rules: readonly LinkRule[]): TextPart[] {
  const compiled = rules.flatMap((rule) => {
    try {
      return [{ regex: new RegExp(rule.pattern, 'g'), url: rule.url }];
    } catch {
      return [];
    }
  });
  const parts: TextPart[] = [];
  let position = 0;
  while (position < text.length) {
    let best: { index: number; match: RegExpExecArray; url: string } | undefined;
    for (const rule of compiled) {
      rule.regex.lastIndex = position;
      const match = rule.regex.exec(text);
      if (match && match[0] && (!best || match.index < best.index))
        best = { index: match.index, match, url: rule.url };
    }
    if (!best) break;
    if (best.index > position) parts.push({ text: text.slice(position, best.index) });
    const groups = best.match;
    const url = best.url.replace(/\$(\d+)/g, (_, n: string) => encodeURIComponent(groups[Number(n)] ?? ''));
    parts.push({ text: groups[0], url });
    position = best.index + groups[0].length;
  }
  if (position < text.length) parts.push({ text: text.slice(position) });
  return parts;
}
