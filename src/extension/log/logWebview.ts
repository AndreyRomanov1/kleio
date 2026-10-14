import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { LogController, type LogServices } from './logController';

const VIEW_TYPE = 'grove.log';
const PANEL_TYPE = 'grove.logPanel';

function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', file));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('webview.css')}">
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
}

/** Owns every place where the log can be shown: the movable view and editor tabs. */
export class LogWebviews implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly controllers = new Set<LogController>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly services: LogServices) {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(VIEW_TYPE, this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
        deserializeWebviewPanel: async (panel) => this.attachPanel(panel),
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = webviewOptions(this.services.context.extensionUri);
    view.webview.html = renderHtml(view.webview, this.services.context.extensionUri);
    const controller = this.track(new LogController(view.webview, this.services));
    view.onDidDispose(() => this.untrack(controller));
  }

  openInEditor(column = vscode.ViewColumn.Active): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, 'Git Log', column, {
      ...webviewOptions(this.services.context.extensionUri),
      retainContextWhenHidden: true,
    });
    this.attachPanel(panel);
    return panel;
  }

  async openInNewWindow(): Promise<void> {
    const panel = this.openInEditor();
    panel.reveal();
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  }

  revealCommit(hash: string): void {
    for (const controller of this.controllers) controller.revealCommit(hash);
  }

  private attachPanel(panel: vscode.WebviewPanel): void {
    panel.iconPath = vscode.Uri.joinPath(this.services.context.extensionUri, 'media', 'grove.svg');
    panel.webview.options = webviewOptions(this.services.context.extensionUri);
    panel.webview.html = renderHtml(panel.webview, this.services.context.extensionUri);
    const controller = this.track(new LogController(panel.webview, this.services));
    panel.onDidDispose(() => this.untrack(controller));
  }

  private track(controller: LogController): LogController {
    this.controllers.add(controller);
    return controller;
  }

  private untrack(controller: LogController): void {
    controller.dispose();
    this.controllers.delete(controller);
  }

  dispose(): void {
    for (const controller of this.controllers) controller.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
