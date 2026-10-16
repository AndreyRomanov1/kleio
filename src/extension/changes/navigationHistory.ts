import * as vscode from 'vscode';
import type { ChangeSetFile, ChangeSetNavigator } from './changeSetNavigator';
import { t } from '../../shared/l10n';

type Place = ({ kind: 'file'; uri: vscode.Uri } | ({ kind: 'diff' } & ChangeSetFile)) & { line: number };

const LIMIT = 200;
/** A jump inside a file of at least this many lines is a place of its own, as in the editor's history. */
const JUMP_LINES = 10;
/** Events of the editors Kleio itself opens while going back or forward are not new places. */
const SETTLE_MS = 400;
/** Editors that are not places to come back to: output, comment boxes, settings and the like. */
const SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-userdata']);

/**
 * Go Back and Go Forward through files and the files of review diffs in one history. The editor's own history
 * loses a diff once Kleio replaces it with the next file of the set, so Kleio keeps the places itself: the
 * editors switched to and the jumps inside them, and the files of change sets shown, with the cursor line.
 */
export class NavigationHistory implements vscode.Disposable {
  private places: Place[] = [];
  private position = -1;
  private quietUntil = 0;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly navigator: ChangeSetNavigator) {
    this.disposables = [
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && !this.quiet()) this.arrive(this.placeOf(editor, editor.selection.active.line));
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      navigator.onDidOpen((file) => {
        if (!this.quiet(true)) this.arrive({ kind: 'diff', ...file });
      }),
      vscode.commands.registerCommand('kleio.navigate.back', () => this.go(-1)),
      vscode.commands.registerCommand('kleio.navigate.forward', () => this.go(1)),
    ];
  }

  /** While Kleio restores a place or opens a diff, editors flicker; `opened` is the event of the open itself. */
  private quiet(opened = false): boolean {
    return Date.now() < this.quietUntil || (!opened && this.navigator.opening);
  }

  private placeOf(editor: vscode.TextEditor, line: number): Place | undefined {
    const uri = editor.document.uri;
    const file = this.navigator.fileOf(uri);
    if (file) return { kind: 'diff', ...file, line };
    return SCHEMES.has(uri.scheme) ? { kind: 'file', uri, line } : undefined;
  }

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (this.quiet() || e.textEditor !== vscode.window.activeTextEditor) return;
    const line = e.selections[0].active.line;
    const place = this.placeOf(e.textEditor, line);
    if (!place) return;
    const current = this.places[this.position];
    if (!current || !same(current, place)) return this.arrive(place);
    // Typing and arrow keys move the place along; a far jump by a click or a command (Go to Definition
    // inside the file, F7 in a diff) leaves the old line to come back to.
    const jump =
      e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard && Math.abs(line - current.line) >= JUMP_LINES;
    if (jump && place.kind === 'file') this.push(place);
    else current.line = line;
  }

  private arrive(place: Place | undefined): void {
    if (!place) return;
    const current = this.places[this.position];
    if (current && same(current, place)) current.line = place.line;
    else this.push(place);
  }

  private push(place: Place): void {
    this.places = [...this.places.slice(0, this.position + 1), place].slice(-LIMIT);
    this.position = this.places.length - 1;
  }

  private async go(step: -1 | 1): Promise<void> {
    const target = this.places[this.position + step];
    if (!target) {
      vscode.window.setStatusBarMessage(
        step < 0 ? t('Kleio: nothing to go back to') : t('Kleio: nothing to go forward to'),
        2000,
      );
      return;
    }
    this.position += step;
    this.quietUntil = Number.POSITIVE_INFINITY;
    try {
      if (target.kind === 'diff') {
        await this.navigator.open(target.changeSet, target.index, 'first', { line: target.line });
      } else {
        const selection = new vscode.Range(target.line, 0, target.line, 0);
        await vscode.window.showTextDocument(target.uri, { selection, preview: false });
      }
    } catch (error) {
      // A file deleted since: the place is dropped, and the place shown stays the current one.
      this.places.splice(this.position, 1);
      if (step > 0) this.position -= 1;
      void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
    } finally {
      this.quietUntil = Date.now() + SETTLE_MS;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function same(a: Place, b: Place): boolean {
  if (a.kind === 'file' && b.kind === 'file') return a.uri.toString() === b.uri.toString();
  if (a.kind === 'diff' && b.kind === 'diff') return a.changeSet === b.changeSet && a.index === b.index;
  return false;
}
