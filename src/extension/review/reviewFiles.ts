import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { revisionUri, workingFileUri } from '../content/revisionUri';
import type { Repository } from '../git/repository';
import type { ReviewFile } from './anchor';

/**
 * The files of the diff `base..head` with the documents its sides open as; a file that is the same on disk
 * opens as the real file, so its comments are in the editor too.
 */
export async function reviewFiles(
  repository: Repository,
  base: string,
  head: string,
): Promise<{ files: ReviewFile[]; rightUris: Map<string, vscode.Uri> }> {
  const changes = await repository.changes(base, head);
  // One call tells which files on disk are the same as at the head.
  const differing = new Set(
    (await repository.git.run(['diff', '--name-only', '-z', head, '--'])).split('\0').filter(Boolean),
  );
  const files: ReviewFile[] = changes.map((change) => {
    const onDisk = !differing.has(change.path) && existsSync(path.join(repository.root, change.path));
    return {
      change,
      left:
        change.status === 'A' ? undefined : revisionUri(repository.root, base, change.oldPath ?? change.path),
      right:
        change.status === 'D'
          ? undefined
          : onDisk
            ? workingFileUri(repository.root, change.path)
            : revisionUri(repository.root, head, change.path),
    };
  });
  const rightUris = new Map(files.filter((f) => f.right).map((f) => [f.change.path, f.right!] as const));
  return { files, rightUris };
}

/** Document URI → file and side, for placing comments. */
export function documentsOf(
  files: readonly ReviewFile[],
): Map<string, { file: ReviewFile; side: 'old' | 'new' }> {
  const documents = new Map<string, { file: ReviewFile; side: 'old' | 'new' }>();
  for (const file of files) {
    if (file.left) documents.set(file.left.toString(), { file, side: 'old' });
    if (file.right) documents.set(file.right.toString(), { file, side: 'new' });
  }
  return documents;
}
