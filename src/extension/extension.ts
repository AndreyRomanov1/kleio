import * as vscode from 'vscode';
import { GitActions } from './actions/gitActions';
import { SyncActions } from './actions/syncActions';
import { AuthorLens } from './blame/authorLens';
import { BlameAnnotations } from './blame/blameAnnotations';
import { NavigationHistory } from './changes/navigationHistory';
import { ChangeSetNavigator } from './changes/changeSetNavigator';
import { CommitView } from './commit/commitView';
import { RevisionFileSystem } from './content/revisionFileSystem';
import { REVISION_SCHEME } from './content/revisionUri';
import { watchGitPath } from './git/gitPath';
import { BranchStatus } from './statusBar/branchStatus';
import { loadLanguage } from './language';
import { checkGit, createOutput } from './output';
import type { Repository } from './git/repository';
import { RepositoryManager } from './git/repositoryManager';
import { ReviewController } from './review/reviewController';
import { ReviewJournal } from './review/reviewJournal';
import { HistoryCommands } from './history/historyCommands';
import { GitHubAuth } from './hosting/githubAuth';
import { GitLabAuth } from './hosting/gitlabAuth';
import { HostingActions } from './hosting/hostingActions';
import { RemoteActions } from './actions/remoteActions';
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
  remotes: RemoteActions;
}

export async function activate(context: vscode.ExtensionContext): Promise<KleioApi> {
  const repositories = new RepositoryManager();
  // First of all: after a reload the editor restores diffs of revisions and waits for their contents.
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(REVISION_SCHEME, new RevisionFileSystem(repositories), {
      isReadonly: true,
      isCaseSensitive: true,
    }),
  );
  context.subscriptions.push(await loadLanguage(context), watchGitPath());
  const output = createOutput();
  context.subscriptions.push(output.disposable);
  void checkGit(output.channel);
  const navigator = new ChangeSetNavigator(context.workspaceState);
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
  const remotes = new RemoteActions(repositories, hosting);
  const cards = new MergeRequestCards(hosting);
  const review = new ReviewController(
    hosting,
    navigator,
    new ReviewJournal(context.globalStorageUri),
    context.globalState,
    context.workspaceState,
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
    remotes,
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
    remotes,
    gitlabAuth,
    githubAuth,
    hosting,
    cards,
    review,
    new AuthorLens(repositories),
    new BranchStatus(repositories, actions),
    new NavigationHistory(navigator),
    push,
    rebase,
    conflicts,
    new CommitView(context, repositories, navigator, {
      push: (repository) => push.open(repository),
      merge: (repository, filePath) => conflicts.openMerge(repository, filePath),
      operation: (repository, action) => sync.operationAction(repository, action),
    }),
    vscode.commands.registerCommand('kleio.log.openInEditor', () => logs.openInEditor()),
    vscode.commands.registerCommand('kleio.log.openInNewWindow', () => logs.openInNewWindow()),
    vscode.commands.registerCommand('kleio.git.updateProject', async () => {
      const repository = await pickRepository(repositories);
      if (repository) await sync.updateProject(repository);
    }),
    vscode.commands.registerCommand('kleio.git.applyPatch', async () => {
      const repository = await pickRepository(repositories);
      if (repository) await actions.applyPatch(repository);
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
  // Diff tabs the editor restored after a reload: the review they belong to, or the change set shown last.
  void review
    .restore(repositories)
    .catch(() => undefined)
    .then(() => navigator.restore(repositories));
  return { repositories, navigator, logs, blame, review, rebase, conflicts, actions, remotes };
}

/** Commands act on the current repository: the one of the active editor or chosen in the log or commit view. */
async function pickRepository(repositories: RepositoryManager): Promise<Repository | undefined> {
  return repositories.current;
}

export function deactivate(): void {}
