import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { l10nBundle } from '../shared/l10n';
import { displayLanguage } from './language';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
}

/** One bundle serves every Kleio webview; `view` picks the interface it mounts. */
export function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  view: 'log' | 'commit' | 'push' | 'rebase' | 'conflicts',
): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', file));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  const translations = JSON.stringify(l10nBundle()).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="${displayLanguage()}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('webview.css')}">
</head>
<body data-view="${view}">
  <div id="app"></div>
  <script nonce="${nonce}" type="application/json" id="l10n">${translations}</script>
  <script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
}
