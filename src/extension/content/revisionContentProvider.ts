import * as vscode from 'vscode';
import type { RepositoryManager } from '../git/repositoryManager';
import { parseRevisionUri } from './revisionUri';

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly repositories: RepositoryManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, rev, path } = parseRevisionUri(uri);
    if (!rev) return '';
    const repository = await this.repositories.get(root);
    if (!repository) return '';
    try {
      const content = await repository.showFile(rev, path);
      return new TextDecoder('utf-8').decode(content);
    } catch {
      return '';
    }
  }
}
