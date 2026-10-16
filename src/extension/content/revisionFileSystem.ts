import * as vscode from 'vscode';
import type { RepositoryManager } from '../git/repositoryManager';
import { parseRevisionUri } from './revisionUri';

/**
 * Contents of files at revisions as a read-only file system, as the built-in Git extension has its `git:`
 * scheme: the editor saves and restores tabs only of file systems, so a diff of revisions comes back after a
 * reload of the window. A side that does not exist (added or deleted file) is an empty file.
 */
export class RevisionFileSystem implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;

  constructor(private readonly repositories: RepositoryManager) {}

  watch(): vscode.Disposable {
    // A revision never changes.
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const content = await this.readFile(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: content.byteLength };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { root, rev, path } = parseRevisionUri(uri);
    if (!rev) return new Uint8Array();
    const repository = await this.repositories.get(root);
    if (!repository) throw vscode.FileSystemError.FileNotFound(uri);
    try {
      return await repository.showFile(rev, path);
    } catch {
      return new Uint8Array();
    }
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
