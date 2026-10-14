import { describe, expect, it } from 'vitest';
import { linkify } from '../src/shared/linkify';

describe('linkify', () => {
  const rules = [
    { pattern: 'PROJ-\\d+', url: 'https://yt.example.com/issue/$0' },
    { pattern: '(?<![\\w&])!(\\d+)\\b', url: 'https://git.example.com/p/-/merge_requests/$1' },
  ];

  it('turns every match of every rule into a link and keeps the text around', () => {
    expect(linkify('PROJ-12: fix, see !34 and PROJ-13', rules)).toEqual([
      { text: 'PROJ-12', url: 'https://yt.example.com/issue/PROJ-12' },
      { text: ': fix, see ' },
      { text: '!34', url: 'https://git.example.com/p/-/merge_requests/34' },
      { text: ' and ' },
      { text: 'PROJ-13', url: 'https://yt.example.com/issue/PROJ-13' },
    ]);
  });

  it('returns the text as is without matches and skips invalid rules', () => {
    expect(linkify('plain text', [{ pattern: '(', url: 'x' }, ...rules])).toEqual([{ text: 'plain text' }]);
  });
});
