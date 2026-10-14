import * as vscode from 'vscode';
import { GitActions } from './actions/gitActions';
import { AuthorLens } from './blame/authorLens';
import { BlameAnnotations } from './blame/blameAnnotations';
import { ChangeSetNavigator } from './changes/changeSetNavigator';
import { CommitView } from './commit/commitView';
import { RevisionContentProvider } from './content/revisionContentProvider';
import { REVISION_SCHEME } from './content/revisionUri';
import { RepositoryManager } from './git/repositoryManager';
import { HistoryCommands } from './history/historyCommands';
import { GitLabAuth } from './hosting/gitlabAuth';
import { HostingActions } from './hosting/hostingActions';
import { HostingService } from './hosting/hostingService';
import { MergeRequestCards } from './hosting/mergeRequestCards';
import { LogWebviews } from './log/logWebview';

export interface GroveApi {
  repositories: RepositoryManager;
  navigator: ChangeSetNavigator;
  logs: LogWebviews;
  blame: BlameAnnotations;
}

export async function activate(context: vscode.ExtensionContext): Promise<GroveApi> {
  const repositories = new RepositoryManager();
  const navigator = new ChangeSetNavigator();
  const actions = new GitActions(repositories);
  const gitlabAuth = new GitLabAuth(context.secrets);
  const hosting = new HostingService(gitlabAuth);
  const hostingActions = new HostingActions(repositories, hosting);
  const cards = new MergeRequestCards(hosting);
  const logs = new LogWebviews({ context, repositories, navigator, actions, hosting, hostingActions, cards });
  const history = new HistoryCommands(repositories, logs, navigator);
  const blame = new BlameAnnotations(repositories, {
    revealInLog: (hash) => logs.revealCommit(hash),
    showCommit: (repository, hash, filePath) => history.showCommitFile(repository, hash, filePath),
  });

  context.subscriptions.push(
    repositories,
    navigator,
    logs,
    history,
    blame,
    hostingActions,
    gitlabAuth,
    hosting,
    cards,
    new AuthorLens(repositories),
    new CommitView(context, repositories, navigator),
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
  return { repositories, navigator, logs, blame };
}

export function deactivate(): void {}
