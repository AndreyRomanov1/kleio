import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import * as vscode from 'vscode';

export interface JournalEntry {
  /** Merge request, e.g. `git.example.com/group/project!12`. */
  mergeRequest: string;
  kind: 'publish' | 'draft';
  /** Where the comment goes: `path:line`, a reply to a thread, or the merge request as a whole. */
  target: string;
  text: string;
}

const FILE = 'review-journal.jsonl';

/**
 * Every review comment is written here before it is sent, and the outcome after, so nothing typed is lost if
 * the request or the editor fails (one JSON object per line).
 */
export class ReviewJournal {
  constructor(private readonly storage: vscode.Uri) {}

  private get uri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storage, FILE);
  }

  /** Records the comment and returns a function to record how sending it ended. */
  async record(entry: JournalEntry): Promise<(outcome: 'sent' | { failed: string }) => Promise<void>> {
    const id = randomUUID();
    await this.append({ id, at: new Date().toISOString(), status: 'sending', ...entry });
    return (outcome) =>
      this.append(
        outcome === 'sent'
          ? { id, at: new Date().toISOString(), status: 'sent' }
          : { id, at: new Date().toISOString(), status: 'failed', error: outcome.failed },
      );
  }

  async open(): Promise<void> {
    await mkdir(this.storage.fsPath, { recursive: true });
    await appendFile(this.uri.fsPath, '');
    await vscode.window.showTextDocument(this.uri, { preview: false });
  }

  private async append(record: object): Promise<void> {
    await mkdir(this.storage.fsPath, { recursive: true });
    await appendFile(this.uri.fsPath, JSON.stringify(record) + '\n', 'utf8');
  }
}
