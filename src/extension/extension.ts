import * as vscode from 'vscode';
import { GitActions } from './actions/gitActions';
import { SyncActions } from './actions/syncActions';
import { AuthorLens } from './blame/authorLens';
import { BlameAnnotations } from './blame/blameAnnotations';
import { ChangeSetNavigator } from './changes/changeSetNavigator';
import { CommitView } from './commit/commitView';
import { RevisionContentProvider } from './content/revisionContentProvider';
import { REVISION_SCHEME } from './content/revisionUri';
import type { Repository } from './git/repository';
import { RepositoryManager } from './git/repositoryManager';
import { ReviewController } from './review/reviewController';
import { ReviewJournal } from './review/reviewJournal';
import { HistoryCommands } from './history/historyCommands';
import { GitLabAuth } from './hosting/gitlabAuth';
import { HostingActions } from './hosting/hostingActions';
import { HostingService } from './hosting/hostingService';
import { MergeRequestCards } from './hosting/mergeRequestCards';
import { LogWebviews } from './log/logWebview';
import { PushDialog } from './push/pushDialog';

export interface GroveApi {
  repositories: RepositoryManager;
  navigator: ChangeSetNavigator;
  logs: LogWebviews;
  blame: BlameAnnotations;
  review: ReviewController;
}

export async function activate(context: vscode.ExtensionContext): Promise<GroveApi> {
  const repositories = new RepositoryManager();
  const navigator = new ChangeSetNavigator();
  const actions = new GitActions(repositories);
  const sync = new SyncActions(repositories);
  const push = new PushDialog(context, repositories, navigator);
  const gitlabAuth = new GitLabAuth(context.secrets);
  const hosting = new HostingService(gitlabAuth);
  const hostingActions = new HostingActions(repositories, hosting);
  const cards = new MergeRequestCards(hosting);
  const review = new ReviewController(hosting, navigator, new ReviewJournal(context.globalStorageUri));
  const logs = new LogWebviews({
    context,
    repositories,
    navigator,
    actions,
    sync,
    push,
    hosting,
    hostingActions,
    cards,
    review,
  });
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
    review,
    new AuthorLens(repositories),
    push,
    new CommitView(context, repositories, navigator, (repository) => push.open(repository)),
    vscode.workspace.registerTextDocumentContentProvider(
      REVISION_SCHEME,
      new RevisionContentProvider(repositories),
    ),
    vscode.commands.registerCommand('grove.log.openInEditor', () => logs.openInEditor()),
    vscode.commands.registerCommand('grove.log.openInNewWindow', () => logs.openInNewWindow()),
    vscode.commands.registerCommand('grove.git.updateProject', async () => {
      const repository = await pickRepository(repositories);
      if (repository) await sync.updateProject(repository);
    }),
    vscode.commands.registerCommand('grove.git.push', async () => {
      const repository = await pickRepository(repositories);
      if (repository) await push.open(repository);
    }),
    vscode.commands.registerCommand('grove.log.focusView', () =>
      vscode.commands.executeCommand('grove.log.focus'),
    ),
  );

  await repositories.scan();
  return { repositories, navigator, logs, blame, review };
}

/** The repository of the active editor, or the only one, or the one the user picks. */
async function pickRepository(repositories: RepositoryManager): Promise<Repository | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const byEditor = active?.scheme === 'file' ? repositories.repositoryFor(active) : undefined;
  if (byEditor) return byEditor;
  const all = repositories.all;
  if (all.length <= 1) return all[0];
  const picked = await vscode.window.showQuickPick(
    all.map((r) => ({ label: r.name, description: r.root, repository: r })),
    { title: 'Репозиторий' },
  );
  return picked?.repository;
}

export function deactivate(): void {}
