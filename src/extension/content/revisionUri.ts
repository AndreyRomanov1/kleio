import * as path from 'node:path';
import * as vscode from 'vscode';

export const REVISION_SCHEME = 'kleio';

interface RevisionQuery {
  root: string;
  /** Empty for a side that does not exist (added or deleted file). */
  rev: string;
  path: string;
}

/**
 * The URI path mirrors the real file path, so the editor picks the language and shows a familiar title.
 */
export function revisionUri(root: string, rev: string, relativePath: string): vscode.Uri {
  const query: RevisionQuery = { root, rev, path: relativePath };
  return vscode.Uri.file(path.join(root, relativePath)).with({
    scheme: REVISION_SCHEME,
    query: JSON.stringify(query),
  });
}

export function emptyUri(root: string, relativePath: string): vscode.Uri {
  return revisionUri(root, '', relativePath);
}

export function parseRevisionUri(uri: vscode.Uri): RevisionQuery {
  return JSON.parse(uri.query) as RevisionQuery;
}

export function workingFileUri(root: string, relativePath: string): vscode.Uri {
  return vscode.Uri.file(path.join(root, relativePath));
}
