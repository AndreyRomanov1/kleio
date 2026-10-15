import * as path from 'node:path';
import * as vscode from 'vscode';
import { UNCOMMITTED, type BlameLine } from '../git/parse';
import type { RepositoryManager } from '../git/repositoryManager';
import { t } from '../../shared/l10n';
import { ignoresFormatting } from './blameAnnotations';

const SYMBOL_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Function,
]);
const MAX_LENSES = 300;
const REFRESH_DELAY_MS = 1500;

interface Declaration {
  range: vscode.Range;
  anchor: vscode.Position;
}

/**
 * Rider's "code authors" vision: above every class and method the author of most of its lines and how many
 * others touched it. A click toggles the line-by-line annotations.
 */
export class AuthorLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly blames = new Map<string, { version: number; lines: Promise<BlameLine[]> }>();
  private refreshTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly repositories: RepositoryManager) {
    this.disposables.push(
      this.changed,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('kleio.codeLens.authors')) this.changed.fire();
      }),
      vscode.workspace.onDidChangeTextDocument(() => this.scheduleRefresh()),
      vscode.workspace.onDidCloseTextDocument((d) => this.blames.delete(d.uri.toString())),
      repositories.onDidChangeRepository(() => {
        this.blames.clear();
        this.changed.fire();
      }),
    );
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (!vscode.workspace.getConfiguration('kleio').get<boolean>('codeLens.authors', true)) return [];
    const repository = this.repositories.repositoryFor(document.uri);
    if (!repository) return [];

    const symbols = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
    >('vscode.executeDocumentSymbolProvider', document.uri);
    if (!symbols?.length || token.isCancellationRequested) return [];
    const declarations = collectDeclarations(symbols).slice(0, MAX_LENSES);
    if (declarations.length === 0) return [];

    const relativePath = path.relative(repository.root, document.uri.fsPath).split(path.sep).join('/');
    let lines: BlameLine[];
    try {
      lines = await this.blameOf(document, () =>
        repository.blame(relativePath, {
          contents: document.isDirty ? document.getText() : undefined,
          ignoreFormatting: ignoresFormatting(),
        }),
      );
    } catch {
      return [];
    }
    if (token.isCancellationRequested) return [];

    return declarations.map((declaration) => {
      const authors = authorsIn(lines, declaration.range);
      const [main, ...others] = authors;
      const title = main
        ? `$(person) ${main.name}${others.length ? ` +${others.length}` : ''}`
        : '$(person) —';
      const tooltip = authors.map((a) => t('{0}: {1} lines', a.name, a.lines)).join('\n');
      return new vscode.CodeLens(new vscode.Range(declaration.anchor, declaration.anchor), {
        title,
        tooltip: `${tooltip}\n\n${t('Click to show the authors line by line')}`,
        command: 'kleio.blame.toggle',
        arguments: [document.uri],
      });
    });
  }

  private blameOf(document: vscode.TextDocument, load: () => Promise<BlameLine[]>): Promise<BlameLine[]> {
    const key = document.uri.toString();
    const cached = this.blames.get(key);
    if (cached && cached.version === document.version) return cached.lines;
    const lines = load();
    this.blames.set(key, { version: document.version, lines });
    return lines;
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.changed.fire(), REFRESH_DELAY_MS);
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }
}

function collectDeclarations(symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): Declaration[] {
  const result: Declaration[] = [];
  const visit = (symbol: vscode.DocumentSymbol | vscode.SymbolInformation) => {
    if ('children' in symbol) {
      if (SYMBOL_KINDS.has(symbol.kind))
        result.push({ range: symbol.range, anchor: symbol.selectionRange.start });
      symbol.children.forEach(visit);
    } else if (SYMBOL_KINDS.has(symbol.kind)) {
      result.push({ range: symbol.location.range, anchor: symbol.location.range.start });
    }
  };
  symbols.forEach(visit);
  return result.sort((a, b) => a.anchor.line - b.anchor.line);
}

interface AuthorShare {
  name: string;
  lines: number;
}

/** Authors of the lines in the range, the one with most lines first; unsaved lines count as yours. */
function authorsIn(lines: BlameLine[], range: vscode.Range): AuthorShare[] {
  const counts = new Map<string, number>();
  for (let line = range.start.line + 1; line <= range.end.line + 1; line++) {
    const blame = lines[line - 1];
    if (!blame) continue;
    const name = blame.commit.hash === UNCOMMITTED ? t('you (not committed)') : blame.commit.author;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, lines: count })).sort((a, b) => b.lines - a.lines);
}
