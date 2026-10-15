import * as vscode from 'vscode';
import type { MergeRequestCardView } from '../../shared/protocol';
import type { Repository } from '../git/repository';
import { GitLabApiError, type GitLabApi } from './gitlabApi';
import { buildCard, buildDiscussions, type ChildJobs } from './mergeRequestCard';
import { GitHubApiError, type GitHubApi, type MergeMethod } from './githubApi';
import { buildGitHubCard } from './githubCard';
import type { HostingService } from './hostingService';

const MAX_CHILD_PIPELINES = 10;
import { cleanLog } from './jobLogText';
import { t } from '../../shared/l10n';

const LOG_SCHEME = 'kleio-job-log';

export type CardResult = { card: MergeRequestCardView } | { needsAuth: true } | { error: string };

/** The merge request card of the log and what can be done from it: job logs and pipeline retry. */
export class MergeRequestCards implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly logs = new Map<string, string>();
  private readonly users = new Map<string, Promise<string | undefined>>();
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly hosting: HostingService) {
    this.disposables = [vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, this)];
  }

  async card(repository: Repository, number: number): Promise<CardResult> {
    if (await this.isGitHub(repository)) {
      const github = await this.hosting.github(repository);
      if (!github) return { needsAuth: true };
      try {
        const { card, viewer } = await github.pullRequestCard(number);
        return { card: buildGitHubCard(card, viewer) };
      } catch (error) {
        if (error instanceof GitHubApiError && error.unauthorized) return { needsAuth: true };
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    const api = await this.hosting.gitlab(repository);
    if (!api) return { needsAuth: true };
    try {
      return { card: await this.load(api, number) };
    } catch (error) {
      if (error instanceof GitLabApiError && error.unauthorized) return { needsAuth: true };
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Asks for access to the repository's GitLab; true when it was given. */
  async connect(repository: Repository): Promise<boolean> {
    return this.hosting.connect(repository);
  }

  async openJobLog(repository: Repository, jobId: number, name: string, projectId?: number): Promise<void> {
    const github = (await this.isGitHub(repository))
      ? await this.hosting.github(repository, true)
      : undefined;
    const api = github ? undefined : await this.hosting.gitlab(repository, true);
    if (!github && !api) return;
    const text = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t('Kleio: log of job {0}', name) },
      () => (github ? github.jobLog(jobId) : api!.jobLog(jobId, projectId)),
    );
    const uri = vscode.Uri.from({ scheme: LOG_SCHEME, path: `/${jobId}/${name.replace(/[/\\]/g, '_')}.log` });
    this.logs.set(uri.toString(), cleanLog(text));
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    // Failures are at the end of a job log.
    const end = new vscode.Position(document.lineCount - 1, 0);
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenter);
  }

  async approve(repository: Repository, iid: number, approve: boolean): Promise<void> {
    const github = await this.githubFor(repository);
    if (github) {
      // GitHub has no taking back of an approval, only a dismissal by maintainers on the web.
      if (!approve) return;
      const { card } = await github.pullRequestCard(iid);
      await this.report(() => github.approve(card.id), t('approved'), 'GitHub');
      return;
    }
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    await this.report(
      () => (approve ? api.approve(iid) : api.unapprove(iid)),
      approve ? t('approved') : t('approval removed'),
    );
  }

  /** Merges after a confirmation that says what will happen; offers auto-merge while a pipeline is running. */
  async merge(repository: Repository, iid: number): Promise<void> {
    const github = await this.githubFor(repository);
    if (github) return this.mergePullRequest(github, iid);
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    const details = await api.mergeRequest(iid);
    const running = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running'].includes(
      details.pipeline?.status ?? '',
    );
    const now = t('Merge');
    const later = t('Merge when the pipeline succeeds');
    const status =
      details.mergeStatus && details.mergeStatus !== 'mergeable'
        ? t('GitLab status: {0}. ', details.mergeStatus)
        : '';
    const choice = await vscode.window.showWarningMessage(
      t('Merge !{0} "{1}" into {2}?', iid, details.title, details.targetBranch),
      {
        modal: true,
        detail:
          `${status}${running ? t('The pipeline is still running: the merge can happen automatically when it succeeds.') : ''}`.trim() ||
          undefined,
      },
      ...(running ? [later, now] : [now]),
    );
    if (!choice) return;
    await this.report(
      () => api.merge(iid, { whenPipelineSucceeds: choice === later }),
      choice === later ? t('will be merged when the pipeline succeeds') : t('the merge request is merged'),
    );
  }

  async rebase(repository: Repository, iid: number): Promise<void> {
    const github = await this.githubFor(repository);
    if (github) {
      const { card } = await github.pullRequestCard(iid);
      const merge = t('Merge {0} into it', card.baseRefName);
      const rebase = t('Rebase onto {0}', card.baseRefName);
      const choice = await vscode.window.showInformationMessage(
        t('Update the branch of #{0} on GitHub?', iid),
        {
          modal: true,
          detail: t(
            'The branch {0} is behind {1}. A rebase rewrites the commits of the branch.',
            card.headRefName,
            card.baseRefName,
          ),
        },
        merge,
        rebase,
      );
      if (!choice) return;
      await this.report(
        () => github.updateBranch(card.id, choice === rebase ? 'REBASE' : 'MERGE'),
        t('the branch is updated on the server'),
        'GitHub',
      );
      return;
    }
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    await this.report(() => api.rebase(iid), t('rebase started on the server'));
  }

  /** Starts a manual job or a trigger job (e.g. a deploy to a stand) after a confirmation. */
  async playJob(repository: Repository, jobId: number, name: string, projectId?: number): Promise<void> {
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    const ok = await vscode.window.showInformationMessage(t('Run "{0}"?', name), { modal: true }, t('Run'));
    if (!ok) return;
    await this.report(() => api.playJob(jobId, projectId), t('"{0}" started', name));
  }

  private async report(action: () => Promise<void>, done: string, service = 'GitLab'): Promise<void> {
    try {
      await action();
      vscode.window.setStatusBarMessage(`Kleio: ${done}`, 4000);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `${service}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Merges a pull request with one of the methods the repository allows; while checks are still running,
   * GitHub can merge it by itself once they pass (auto-merge, when the repository has it turned on).
   */
  private async mergePullRequest(github: GitHubApi, number: number): Promise<void> {
    const { card, methods } = await github.pullRequestCard(number);
    const view = buildGitHubCard(card, '');
    const running = view.pipeline && ['pending', 'running'].includes(view.pipeline.status);
    const labels: Record<MergeMethod, string> = {
      MERGE: t('Create a merge commit'),
      SQUASH: t('Squash and merge'),
      REBASE: t('Rebase and merge'),
    };
    const items = methods.flatMap((method) => [
      { label: labels[method], method, later: false },
      ...(running
        ? [{ label: labels[method], description: t('when the checks pass'), method, later: true }]
        : []),
    ]);
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Merge #{0} "{1}" into {2}', number, card.title, card.baseRefName),
      placeHolder:
        [
          view.hasConflicts ? t('conflicts') : '',
          running ? t('The checks are still running.') : '',
          card.mergeStateStatus === 'BLOCKED'
            ? t('GitHub blocks the merge: reviews or checks are missing.')
            : '',
        ]
          .filter(Boolean)
          .join(' ') || t('How to merge'),
    });
    if (!picked) return;
    await this.report(
      () => github.merge(card.id, picked.method, picked.later),
      picked.later ? t('will be merged when the checks pass') : t('the pull request is merged'),
      'GitHub',
    );
  }

  private async isGitHub(repository: Repository): Promise<boolean> {
    return (await this.hosting.known(repository))?.links?.kind === 'github';
  }

  /** The GitHub API of a repository hosted there, asking for access if needed. */
  private async githubFor(repository: Repository): Promise<GitHubApi | undefined> {
    return (await this.isGitHub(repository)) ? this.hosting.github(repository, true) : undefined;
  }

  async retryPipeline(repository: Repository, pipelineId: number, number?: number): Promise<void> {
    const github = await this.githubFor(repository);
    if (github) {
      if (number === undefined) return;
      const { card } = await github.pullRequestCard(number);
      const failed = new Set(
        (buildGitHubCard(card, '').pipeline?.stages ?? [])
          .flatMap((s) => s.jobs)
          .filter((j) => j.runId && (j.status === 'failed' || j.status === 'canceled'))
          .map((j) => j.runId!),
      );
      await this.report(
        async () => {
          for (const run of failed) await github.rerunFailedJobs(run);
        },
        t('failed jobs are retried'),
        'GitHub',
      );
      return;
    }
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    await api.retryPipeline(pipelineId);
    vscode.window.setStatusBarMessage(t('Kleio: failed jobs are retried'), 4000);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.logs.get(uri.toString()) ?? '';
  }

  private async load(api: GitLabApi, number: number): Promise<MergeRequestCardView> {
    const [details, approvals, discussions, drafts] = await Promise.all([
      api.mergeRequest(number),
      api.approvals(number),
      api.discussions(number).catch(() => []),
      api.draftNotes(number).catch(() => []),
    ]);
    const me = await this.currentUser(api);
    const withDiscussions = (card: MergeRequestCardView): MergeRequestCardView => ({
      ...card,
      discussions: buildDiscussions(discussions, drafts, details.diffRefs?.headSha),
      approvedByMe: !!me && approvals.approvedBy.some((p) => p.username === me),
    });
    if (!details.pipeline) return withDiscussions(buildCard(details, approvals, []));
    const [jobs, bridges] = await Promise.all([
      api.jobs(details.pipeline.id),
      api.bridges(details.pipeline.id).catch(() => []),
    ]);
    // Child pipelines are few (deploys started by hand), so their jobs are loaded with the card.
    const children: ChildJobs = {};
    await Promise.all(
      bridges
        .filter((b) => b.downstream)
        .slice(0, MAX_CHILD_PIPELINES)
        .map(async (b) => {
          children[b.downstream!.id] = await api
            .jobs(b.downstream!.id, b.downstream!.projectId)
            .catch(() => []);
        }),
    );
    return withDiscussions(buildCard(details, approvals, jobs, bridges, children));
  }

  /** Username of the GitLab user Kleio acts as, once per host. */
  private currentUser(api: GitLabApi): Promise<string | undefined> {
    let user = this.users.get(api.host);
    if (!user) {
      user = api
        .currentUser()
        .then((p) => p.username)
        .catch(() => undefined);
      this.users.set(api.host, user);
    }
    return user;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
