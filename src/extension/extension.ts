import * as vscode from 'vscode';
import { GitActions } from './actions/gitActions';
import { SyncActions } from './actions/syncActions';
import { AuthorLens } from './blame/authorLens';
import { BlameAnnotations } from './blame/blameAnnotations';
import { ChangeSetNavigator } from './changes/changeSetNavigator';
import { CommitView } from './commit/commitView';
import { RevisionContentProvider } from './content/revisionContentProvider';
import { REVISION_SCHEME } from './content/revisionUri';
import { t } from '../shared/l10n';
import { watchGitPath } from './git/gitPath';
import { BranchStatus } from './statusBar/branchStatus';
import { loadLanguage } from './language';
import type { Repository } from './git/repository';
import { RepositoryManager } from './git/repositoryManager';
import { ReviewController } from './review/reviewController';
import { ReviewJournal } from './review/reviewJournal';
import { HistoryCommands } from './history/historyCommands';
import { GitHubAuth } from './hosting/githubAuth';
import { GitLabAuth } from './hosting/gitlabAuth';
import { HostingActions } from './hosting/hostingActions';
import { HostingService } from './hosting/hostingService';
import { MergeRequestCards } from './hosting/mergeRequestCards';
import { LogWebviews } from './log/logWebview';
import { PushDialog } from './push/pushDialog';
import { RebaseDialog } from './rebase/rebaseDialog';
import { ConflictsWindow } from './conflicts/conflictsWindow';

export interface KleioApi {
  repositories: RepositoryManager;
  navigator: ChangeSetNavigator;
  logs: LogWebviews;
  blame: BlameAnnotations;
  review: ReviewController;
  rebase: RebaseDialog;
  conflicts: ConflictsWindow;
  actions: GitActions;
}

export async function activate(context: vscode.ExtensionContext): Promise<KleioApi> {
  context.subscriptions.push(await loadLanguage(context), watchGitPath());
  const repositories = new RepositoryManager();
  const navigator = new ChangeSetNavigator();
  const sync = new SyncActions(repositories);
  const actions = new GitActions(repositories, sync);
  const push = new PushDialog(context, repositories, navigator);
  const rebase = new RebaseDialog(context, navigator, sync);
  const conflicts = new ConflictsWindow(context, repositories, sync);
  sync.showConflicts = (repository) => conflicts.open(repository);
  const gitlabAuth = new GitLabAuth(context.secrets);
  const githubAuth = new GitHubAuth(context.secrets);
  const hosting = new HostingService(gitlabAuth, githubAuth);
  const hostingActions = new HostingActions(repositories, hosting);
  const cards = new MergeRequestCards(hosting);
  const review = new ReviewController(
    hosting,
    navigator,
    new ReviewJournal(context.globalStorageUri),
    context.globalState,
  );
  const logs = new LogWebviews({
    context,
    repositories,
    navigator,
    actions,
    sync,
    push,
    rebase,
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
    githubAuth,
    hosting,
    cards,
    review,
    new AuthorLens(repositories),
    new BranchStatus(repositories, actions),
    push,
    rebase,
    conflicts,
    new CommitView(context, repositories, navigator, {
      push: (repository) => push.open(repository),
      merge: (repository, filePath) => conflicts.openMerge(repository, filePath),
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      REVISION_SCHEME,
      new RevisionContentProvider(repositories),
    ),
    vscode.commands.registerCommand('kleio.log.openInEditor', () => logs.openInEditor()),
    vscode.commands.registerCommand('kleio.log.openInNewWindow', () => logs.openInNewWindow()),
    vscode.commands.registerCommand('kleio.git.updateProject', async () => {
      const repository = await pickRepository(repositories);
      if (repository) await sync.updateProject(repository);
    }),
    vscode.commands.registerCommand('kleio.git.undo', async () => {
      const repository = await pickRepository(repositories);
      if (repository) await sync.undo(repository);
    }),
    vscode.commands.registerCommand('kleio.git.push', async () => {
      const repository = await pickRepository(repositories);
      if (repository) await push.open(repository);
    }),
    vscode.commands.registerCommand('kleio.log.focusView', () =>
      vscode.commands.executeCommand('kleio.log.focus'),
    ),
  );

  await repositories.scan();
  return { repositories, navigator, logs, blame, review, rebase, conflicts, actions };
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
    { title: t('Repository') },
  );
  return picked?.repository;
}

export function deactivate(): void {}
