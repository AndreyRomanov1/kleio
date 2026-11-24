import * as vscode from 'vscode';
import { t } from '../../shared/l10n';
import type { ChangeSet } from '../changes/changeSet';
import type { ChangeSetNavigator } from '../changes/changeSetNavigator';
import { revealOld, sidesOf } from './anchor';

/**
 * Jumps to the next or previous thread through the diffs of `chain` in their order, then by files of each diff,
 * then by lines. A thread outside the diffs of the chain is skipped.
 */
export async function moveToComment(
  navigator: ChangeSetNavigator,
  threads: readonly vscode.CommentThread[],
  chain: readonly ChangeSet[],
  shown: ChangeSet | undefined,
  direction: 1 | -1,
): Promise<void> {
  const sides = chain.map(sidesOf);
  const locate = (uri: vscode.Uri) => {
    for (const [group, map] of sides.entries()) {
      const side = map.get(uri.toString());
      if (side) return { group, ...side };
    }
    return undefined;
  };
  const targets = threads
    .filter((t) => t.range)
    .map((thread) => ({ thread, line: thread.range!.start.line, at: locate(thread.uri) }))
    .filter((t): t is typeof t & { at: NonNullable<typeof t.at> } => !!t.at)
    .sort((a, b) => a.at.group - b.at.group || a.at.index - b.at.index || a.line - b.line);
  if (targets.length === 0) {
    vscode.window.setStatusBarMessage(t('Kleio: the merge request has no comments in the code'), 3000);
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const here = editor && locate(editor.document.uri);
  const key = here
    ? [here.group, here.index, editor!.selection.active.line]
    : [shown ? chain.indexOf(shown) : 0, -1, -1];
  const compare = (t: (typeof targets)[number]) =>
    t.at.group - key[0] || t.at.index - key[1] || t.line - key[2];
  const target =
    direction === 1
      ? targets.find((t) => compare(t) > 0)
      : [...targets].reverse().find((t) => compare(t) < 0);
  if (!target) {
    vscode.window.setStatusBarMessage(
      direction === 1 ? t('Kleio: this is the last comment') : t('Kleio: this is the first comment'),
      3000,
    );
    return;
  }
  target.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  const set = chain[target.at.group];
  const visible = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === target.thread.uri.toString(),
  );
  if (visible && set === shown && here?.index === target.at.index) {
    const position = new vscode.Position(target.line, 0);
    visible.selection = new vscode.Selection(position, position);
    visible.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    return;
  }
  const onNew = target.at.side === 'new';
  await navigator.open(set, target.at.index, 'first', { line: onNew ? target.line : undefined });
  if (!onNew) revealOld(set, target.at.index, target.line);
}

/**
 * The change set the active diff tab is of. Its left side tells it, as each set has its own; the right side
 * of a review is also that of the diffs of its versions.
 */
export function shownSet(navigator: ChangeSetNavigator, sets: readonly ChangeSet[]): ChangeSet | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof vscode.TabInputTextDiff)) return undefined;
  const original = input.original.toString();
  const modified = input.modified.toString();
  const scored = sets
    .map((set) => {
      const sides = sidesOf(set);
      return { set, score: (sides.has(original) ? 2 : 0) + (sides.has(modified) ? 1 : 0) };
    })
    .filter((s) => s.score > 0);
  const best = Math.max(0, ...scored.map((s) => s.score));
  const candidates = scored.filter((s) => s.score === best).map((s) => s.set);
  const navigated = navigator.shown;
  return candidates.find((set) => set === navigated) ?? candidates[0];
}
