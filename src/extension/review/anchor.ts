import * as vscode from 'vscode';
import type { FileChange } from '../../shared/model';
import type { ChangeSet } from '../changes/changeSet';
import { revisionUri } from '../content/revisionUri';
import type { Repository } from '../git/repository';
import type { DiffPosition } from '../hosting/gitlabApi';
import { followLine, type Side } from './positions';

/**
 * Where a comment was made: lines of one side of a file in the diff `baseSha..headSha`, 1-based; `startLine` is
 * the first one of several.
 */
export interface Anchor {
  baseSha: string;
  headSha: string;
  oldPath: string;
  newPath: string;
  side: Side;
  line: number;
  startLine?: number;
}

/** A document and its lines, where a thread is shown. */
export interface Place {
  uri: vscode.Uri;
  range: vscode.Range;
}

/** A file of a diff under review with the documents its sides open as. */
export interface ReviewFile {
  change: FileChange;
  left?: vscode.Uri;
  right?: vscode.Uri;
}

/** GitLab keeps a line by the number on its side; a line on both sides has both, and counts as the new one. */
export function anchorOf(position: DiffPosition): Anchor {
  const side: Side = position.newLine !== undefined ? 'new' : 'old';
  const start = position.lineRange?.start;
  return {
    baseSha: position.baseSha,
    headSha: position.headSha,
    oldPath: position.oldPath,
    newPath: position.newPath,
    side,
    line: (side === 'new' ? position.newLine : position.oldLine) ?? 1,
    startLine: side === 'new' ? start?.newLine : start?.oldLine,
  };
}

export function linesRange(line: number, startLine = line): vscode.Range {
  return new vscode.Range(Math.min(startLine, line) - 1, 0, line - 1, 0);
}

/** The anchor in the diff under review, on the same version. */
export function placeIn(files: readonly ReviewFile[], anchor: Anchor): Place | undefined {
  const file = files.find(
    (f) => f.change.path === anchor.newPath || (f.change.oldPath ?? f.change.path) === anchor.oldPath,
  );
  const uri = anchor.side === 'new' ? file?.right : file?.left;
  return uri && { uri, range: linesRange(anchor.line, anchor.startLine) };
}

/** The anchor in the version it was made on. */
export function versionPlaceOf(root: string, anchor: Anchor): Place {
  const uri =
    anchor.side === 'new'
      ? revisionUri(root, anchor.headSha, anchor.newPath)
      : revisionUri(root, anchor.baseSha, anchor.oldPath);
  return { uri, range: linesRange(anchor.line, anchor.startLine) };
}

/**
 * The lines of an anchor on the new side, followed from its version to another revision where the file is at
 * `path`; undefined when they changed in between.
 */
export async function followAnchor(
  repository: Repository,
  anchor: Anchor,
  to: string,
  path: string,
): Promise<vscode.Range | undefined> {
  if (anchor.side !== 'new') return undefined;
  const hunks =
    anchor.headSha === to
      ? []
      : await repository
          .hunks(anchor.headSha, to, { status: 'R', path, oldPath: anchor.newPath })
          .catch(() => undefined);
  const line = hunks && followLine(hunks, anchor.line);
  if (!line) return undefined;
  const start = anchor.startLine === undefined ? undefined : followLine(hunks, anchor.startLine);
  return linesRange(line, start || line);
}

export function samePlace(a: Place, b: Place): boolean {
  return a.uri.toString() === b.uri.toString() && a.range.isEqual(b.range);
}

/** The documents of both sides of each file of a change set, as the diff viewer opens them. */
export function sidesOf(set: ChangeSet): Map<string, { index: number; side: Side }> {
  const sides = new Map<string, { index: number; side: Side }>();
  const root = set.repository.root;
  set.files.forEach((change, index) => {
    if (change.status !== 'A' && set.left !== undefined)
      sides.set(revisionUri(root, set.left, change.oldPath ?? change.path).toString(), {
        index,
        side: 'old',
      });
    if (change.status !== 'D') {
      const right = set.rightUris?.get(change.path) ?? revisionUri(root, set.right, change.path);
      sides.set(right.toString(), { index, side: 'new' });
    }
  });
  return sides;
}

/** The diff reveals lines of its new side; a line of the old side is revealed there once the diff is shown. */
export function revealOld(set: ChangeSet, index: number, line: number): void {
  const change = set.files[index];
  if (!change || set.left === undefined) return;
  const uri = revisionUri(set.repository.root, set.left, change.oldPath ?? change.path).toString();
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
  const position = new vscode.Position(line, 0);
  editor?.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}
