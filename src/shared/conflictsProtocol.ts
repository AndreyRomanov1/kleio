import type { OperationKind } from './model';

export interface ConflictFileView {
  path: string;
  /** Whether each side has the file: a missing one means it was deleted there (or not added). */
  base: boolean;
  ours: boolean;
  theirs: boolean;
}

export interface ConflictSides {
  /** What git calls "ours": the current branch of a merge, the branch being built by a rebase. */
  ours: string;
  /** What git calls "theirs": the merged branch, the commit being applied by a rebase or cherry-pick. */
  theirs: string;
}

export type ConflictsHostMessage =
  | {
      type: 'state';
      operation?: OperationKind;
      /** Short description, e.g. `rebase PROJ-1234 на main · шаг 2 из 5`. */
      title: string;
      sides: ConflictSides;
      files: ConflictFileView[];
    }
  | { type: 'busy'; value: boolean };

export type ConflictsWebviewMessage =
  | { type: 'ready' }
  | { type: 'resolve'; paths: string[]; side: 'ours' | 'theirs' }
  | { type: 'merge'; path: string }
  | { type: 'operation'; action: 'continue' | 'abort' }
  | { type: 'close' };
