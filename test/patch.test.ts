import { describe, expect, it } from 'vitest';
import { parseFilePatch, selectHunks } from '../src/extension/git/patch';

const diff = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
-one
+ONE
 two
 three
@@ -10,3 +10,4 @@ context
 ten
+ten and a half
 eleven
 twelve
`;

describe('parseFilePatch', () => {
  it('splits a diff into the header and hunks with keys that ignore line numbers', () => {
    const patch = parseFilePatch(diff);
    expect(patch.header).toHaveLength(4);
    expect(patch.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 3, 1, 3],
      [10, 3, 10, 4],
    ]);
    const shifted = parseFilePatch(diff.replace('@@ -10,3 +10,4 @@', '@@ -12,3 +12,4 @@'));
    expect(shifted.hunks[1].key).toBe(patch.hunks[1].key);
    expect(patch.hunks[0].key).not.toBe(patch.hunks[1].key);
  });

  it('builds a patch of the chosen hunks only', () => {
    const patch = parseFilePatch(diff);
    const text = selectHunks(patch, new Set([patch.hunks[1].key]));
    expect(text).toContain('+ten and a half');
    expect(text).not.toContain('+ONE');
    expect(text.startsWith('diff --git a/a.txt b/a.txt\n')).toBe(true);
  });

  it('has no hunks for a binary file', () => {
    expect(parseFilePatch('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n').hunks).toEqual([]);
  });
});
