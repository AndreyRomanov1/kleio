import * as vscode from 'vscode';
import { GitActions } from './actions/gitActions';
import { ChangeSetNavigator } from './changes/changeSetNavigator';
import { RevisionContentProvider } from './content/revisionContentProvider';
import { REVISION_SCHEME } from './content/revisionUri';
import { RepositoryManager } from './git/repositoryManager';
import { LogWebviews } from './log/logWebview';

export interface GroveApi {
  repositories: RepositoryManager;
  navigator: ChangeSetNavigator;
  logs: LogWebviews;
}

export async function activate(context: vscode.ExtensionContext): Promise<GroveApi> {
  const repositories = new RepositoryManager();
  const navigator = new ChangeSetNavigator();
  const actions = new GitActions(repositories);
  const logs = new LogWebviews({ context, repositories, navigator, actions });

  context.subscriptions.push(
    repositories,
    navigator,
    logs,
    vscode.workspace.registerTextDocumentContentProvider(
      REVISION_SCHEME,
      new RevisionContentProvider(repositories),
    ),
    vscode.commands.registerCommand('grove.log.openInEditor', () => logs.openInEditor()),
    vscode.commands.registerCommand('grove.log.openInNewWindow', () => logs.openInNewWindow()),
    vscode.commands.registerCommand('grove.log.focusView', () =>
      vscode.commands.executeCommand('grove.log.focus'),
    ),
  );

  await repositories.scan();
  return { repositories, navigator, logs };
}

export function deactivate(): void {}
