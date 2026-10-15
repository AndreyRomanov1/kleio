import * as vscode from 'vscode';
import { setL10nBundle, t } from '../shared/l10n';

let language = vscode.env.language;

/** The language of Kleio: the editor's display language, or the one set in `kleio.language`. */
export function displayLanguage(): string {
  return language;
}

/**
 * Picks the translations: VS Code's own for the display language, or the bundle of the language chosen in the
 * settings, which works without a language pack. Commands and settings follow the editor's language anyway.
 */
export async function loadLanguage(context: vscode.ExtensionContext): Promise<vscode.Disposable> {
  const chosen = vscode.workspace.getConfiguration('kleio').get<string>('language', 'auto').trim();
  if (!chosen || chosen === 'auto') {
    setL10nBundle(vscode.l10n.bundle);
  } else {
    language = chosen;
    const file = vscode.Uri.joinPath(context.extensionUri, 'l10n', `bundle.l10n.${chosen}.json`);
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
      setL10nBundle(JSON.parse(text) as Record<string, string>);
    } catch {
      setL10nBundle(undefined);
    }
  }
  return vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (!event.affectsConfiguration('kleio.language')) return;
    const reload = t('Reload Window');
    const choice = await vscode.window.showInformationMessage(
      t('The language of Kleio changes after the window is reloaded.'),
      reload,
    );
    if (choice === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  });
}
