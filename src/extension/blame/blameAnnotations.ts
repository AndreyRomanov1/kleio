import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseRevisionUri, REVISION_SCHEME, revisionUri } from '../content/revisionUri';
import { UNCOMMITTED, type BlameLine } from '../git/parse';
import type { Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import { t } from '../../shared/l10n';
import { displayLanguage } from '../language';

const CONTEXT_KEY = 'kleio.blameActive';
const REFRESH_DELAY_MS = 600;
const LABEL_WIDTH = 20;
const MAX_AUTHOR = 10;

interface Target {
  repository: Repository;
  /** Path relative to the repository root. */
  path: string;
  /** Undefined for the working file. */
  revision?: string;
}

interface Annotation {
  target: Target;
  lines: BlameLine[];
}

export interface BlameLinkHandlers {
  revealInLog(hash: string): Promise<void>;
  showCommit(repository: Repository, hash: string, filePath: string): Promise<void>;
}

const LINK_COMMANDS = ['kleio.blame.revealInLog', 'kleio.blame.showCommit', 'kleio.blame.annotatePrevious'];

/** Rider-style "Annotate with Git Blame": author and date next to every line, details and links on hover. */
export class BlameAnnotations implements vscode.Disposable {
  private readonly annotations = new Map<string, Annotation>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('editorLineNumber.foreground'),
      margin: '0 1.2em 0 0',
    },
  });
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly repositories: RepositoryManager,
    private readonly links: BlameLinkHandlers,
  ) {
    this.disposables.push(
      this.decoration,
      vscode.commands.registerCommand('kleio.blame.show', (uri?: vscode.Uri) => this.show(uri)),
      vscode.commands.registerCommand('kleio.blame.hide', (uri?: vscode.Uri) => this.hide(uri)),
      vscode.commands.registerCommand('kleio.blame.toggle', (uri?: vscode.Uri) => this.toggle(uri)),
      vscode.commands.registerCommand('kleio.blame.revealInLog', (hash: string) =>
        this.links.revealInLog(hash),
      ),
      vscode.commands.registerCommand(
        'kleio.blame.showCommit',
        (args: { root: string; hash: string; path: string }) => this.showCommit(args),
      ),
      vscode.commands.registerCommand(
        'kleio.blame.annotatePrevious',
        (args: { root: string; hash: string; path: string; line: number }) => this.annotatePrevious(args),
      ),
      vscode.commands.registerCommand('kleio.blame.lineInLog', () => this.lineInLog()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderVisible()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleRefresh(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.annotations.delete(d.uri.toString())),
    );
  }

  /** Blame lines shown for the document, if it is annotated. */
  linesOf(uri: vscode.Uri): readonly BlameLine[] | undefined {
    return this.annotations.get(uri.toString())?.lines;
  }

  private async toggle(uri?: vscode.Uri): Promise<void> {
    const document = await this.documentFor(uri);
    if (!document) return;
    if (this.annotations.has(document.uri.toString())) await this.hide(document.uri);
    else await this.show(document.uri);
  }

  private async show(uri?: vscode.Uri): Promise<void> {
    const document = await this.documentFor(uri);
    if (!document) return;
    const target = await this.targetFor(document.uri);
    if (!target) {
      void vscode.window.showWarningMessage(t('The file is not in a git repository.'));
      return;
    }
    try {
      const lines = await this.blame(target, document);
      this.annotations.set(document.uri.toString(), { target, lines });
      this.renderVisible();
      this.updateContext();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(t('Blame is not available: {0}', message));
    }
  }

  private async hide(uri?: vscode.Uri): Promise<void> {
    const document = await this.documentFor(uri);
    if (!document) return;
    this.annotations.delete(document.uri.toString());
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) editor.setDecorations(this.decoration, []);
    }
    this.updateContext();
  }

  /** The commit that last changed the line under the cursor, shown in the log. */
  private async lineInLog(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const target = await this.targetFor(editor.document.uri);
    if (!target) return;
    const line = editor.selection.active.line + 1;
    const known = this.annotations.get(editor.document.uri.toString())?.lines.find((l) => l.line === line);
    const blame = known ? [known] : await this.blame(target, editor.document).catch(() => []);
    const hit = blame.find((l) => l.line === line);
    if (!hit || hit.commit.hash === UNCOMMITTED) {
      vscode.window.setStatusBarMessage(t('Kleio: the line is not committed yet'), 3000);
      return;
    }
    await this.links.revealInLog(hit.commit.hash);
  }

  private async showCommit(args: { root: string; hash: string; path: string }): Promise<void> {
    const repository = await this.repositories.get(args.root);
    if (repository) await this.links.showCommit(repository, args.hash, args.path);
  }

  /** Rider's "Annotate Previous Revision": the file as it was before the commit that changed the line. */
  private async annotatePrevious(args: {
    root: string;
    hash: string;
    path: string;
    line: number;
  }): Promise<void> {
    const repository = await this.repositories.get(args.root);
    if (!repository) return;
    const annotation = [...this.annotations.values()].find((a) =>
      a.lines.some((l) => l.commit.hash === args.hash),
    );
    const previous = annotation?.lines.find((l) => l.commit.hash === args.hash)?.commit.previous;
    if (!previous) {
      void vscode.window.showInformationMessage(
        t('The line appeared in this commit: there is no previous revision.'),
      );
      return;
    }
    const uri = revisionUri(repository.root, previous.hash, previous.filename);
    const line = Math.max(0, args.line - 1);
    const editor = await vscode.window.showTextDocument(uri, {
      preview: false,
      selection: new vscode.Range(line, 0, line, 0),
    });
    await this.show(editor.document.uri);
  }

  private async blame(target: Target, document: vscode.TextDocument): Promise<BlameLine[]> {
    const ignoreFormatting = ignoresFormatting();
    if (target.revision)
      return target.repository.blame(target.path, { revision: target.revision, ignoreFormatting });
    return target.repository.blame(target.path, {
      contents: document.isDirty ? document.getText() : undefined,
      ignoreFormatting,
    });
  }

  private scheduleRefresh(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const annotation = this.annotations.get(key);
    if (!annotation || annotation.target.revision) return;
    clearTimeout(this.pending.get(key));
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        void this.blame(annotation.target, document)
          .then((lines) => {
            if (!this.annotations.has(key)) return;
            this.annotations.set(key, { target: annotation.target, lines });
            this.renderVisible();
          })
          .catch(() => undefined);
      }, REFRESH_DELAY_MS),
    );
  }

  private renderVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const annotation = this.annotations.get(editor.document.uri.toString());
      if (annotation) editor.setDecorations(this.decoration, this.decorationsFor(annotation));
    }
  }

  private decorationsFor({ target, lines }: Annotation): vscode.DecorationOptions[] {
    const committed = lines.filter((l) => l.commit.hash !== UNCOMMITTED).map((l) => l.commit.authorTime);
    const oldest = Math.min(...committed);
    const newest = Math.max(...committed);
    const hovers = new Map<string, vscode.MarkdownString>();
    return lines.map((line) => {
      const commit = line.commit;
      const uncommitted = commit.hash === UNCOMMITTED;
      let hover = hovers.get(commit.hash);
      if (!hover) {
        hover = this.hoverFor(target, line);
        hovers.set(commit.hash, hover);
      }
      const position = new vscode.Position(line.line - 1, 0);
      return {
        range: new vscode.Range(position, position),
        hoverMessage: hover,
        renderOptions: {
          before: {
            contentText: uncommitted
              ? pad(t('not committed'))
              : pad(`${shortDate(commit.authorTime)} ${shortAuthor(commit.author)}`),
            backgroundColor: uncommitted
              ? 'rgba(80, 200, 120, 0.25)'
              : heat(commit.authorTime, oldest, newest),
          },
        },
      };
    });
  }

  private hoverFor(target: Target, line: BlameLine): vscode.MarkdownString {
    const commit = line.commit;
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = { enabledCommands: LINK_COMMANDS };
    if (commit.hash === UNCOMMITTED) {
      markdown.appendMarkdown(`**${t('Not committed')}**`);
      return markdown;
    }
    const link = (title: string, command: string, args: unknown) =>
      `[${title}](command:${command}?${encodeURIComponent(JSON.stringify([args]))})`;
    const root = target.repository.root;
    markdown.appendMarkdown(`**${escape(commit.summary)}**\n\n`);
    markdown.appendMarkdown(
      `${escape(commit.author)} <${escape(commit.authorMail)}>, ${fullDate(commit.authorTime)} · \`${commit.hash.slice(0, 8)}\`\n\n`,
    );
    if (commit.filename !== target.path)
      markdown.appendMarkdown(
        t('The file was named `{0}` then', commit.filename.replace(/`/g, "'")) + '\n\n',
      );
    markdown.appendMarkdown(
      [
        link(`$(git-commit) ${t('Show in log')}`, 'kleio.blame.revealInLog', commit.hash),
        link(`$(diff) ${t('Commit diff')}`, 'kleio.blame.showCommit', {
          root,
          hash: commit.hash,
          path: commit.filename,
        }),
        commit.previous
          ? link(`$(history) ${t('Previous revision')}`, 'kleio.blame.annotatePrevious', {
              root,
              hash: commit.hash,
              path: commit.filename,
              line: line.originalLine,
            })
          : '',
      ]
        .filter(Boolean)
        .join(' &nbsp;·&nbsp; '),
    );
    return markdown;
  }

  private async targetFor(uri: vscode.Uri): Promise<Target | undefined> {
    if (uri.scheme === REVISION_SCHEME) {
      const { root, rev, path: filePath } = parseRevisionUri(uri);
      const repository = rev ? await this.repositories.get(root) : undefined;
      return repository ? { repository, path: filePath, revision: rev } : undefined;
    }
    if (uri.scheme !== 'file') return undefined;
    const repository =
      this.repositories.repositoryFor(uri) ?? (await this.repositories.get(path.dirname(uri.fsPath)));
    if (!repository) return undefined;
    return { repository, path: path.relative(repository.root, uri.fsPath).split(path.sep).join('/') };
  }

  private async documentFor(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    if (uri && uri.toString() !== vscode.window.activeTextEditor?.document.uri.toString()) {
      return vscode.workspace.openTextDocument(uri);
    }
    return vscode.window.activeTextEditor?.document;
  }

  private updateContext(): void {
    const uri = vscode.window.activeTextEditor?.document.uri.toString();
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, !!uri && this.annotations.has(uri));
  }

  dispose(): void {
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    for (const d of this.disposables) d.dispose();
  }
}

let formats: { short: Intl.DateTimeFormat; full: Intl.DateTimeFormat } | undefined;

/** Made on first use: the language is known only after activation. */
function dateFormats(): { short: Intl.DateTimeFormat; full: Intl.DateTimeFormat } {
  return (formats ??= {
    short: new Intl.DateTimeFormat(displayLanguage(), { day: '2-digit', month: '2-digit', year: '2-digit' }),
    full: new Intl.DateTimeFormat(displayLanguage(), { dateStyle: 'long', timeStyle: 'short' }),
  });
}

export function ignoresFormatting(): boolean {
  return vscode.workspace.getConfiguration('kleio').get<boolean>('blame.ignoreWhitespaceAndMoves', false);
}

function shortDate(unixSeconds: number): string {
  return dateFormats().short.format(new Date(unixSeconds * 1000));
}

function fullDate(unixSeconds: number): string {
  return dateFormats().full.format(new Date(unixSeconds * 1000));
}

function shortAuthor(author: string): string {
  const first = author.split(/\s+/)[0] ?? author;
  return first.length > MAX_AUTHOR ? `${first.slice(0, MAX_AUTHOR - 1)}…` : first;
}

/** Pads with no-break spaces: the editor font is monospaced, so labels line up as a column. */
function pad(text: string): string {
  return text.length >= LABEL_WIDTH ? text : text + ' '.repeat(LABEL_WIDTH - text.length);
}

/** Newer changes stand out more, like Rider's age colouring of annotations. */
function heat(time: number, oldest: number, newest: number): string {
  const share = newest > oldest ? (time - oldest) / (newest - oldest) : 1;
  const alpha = 0.04 + 0.3 * share * share;
  return `rgba(55, 148, 255, ${alpha.toFixed(3)})`;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
