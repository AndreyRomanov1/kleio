import * as vscode from 'vscode';
import type { MergeRequestCardView } from '../../shared/protocol';
import type { Repository } from '../git/repository';
import { GitLabApiError, type GitLabApi } from './gitlabApi';
import { buildCard, buildDiscussions, type ChildJobs } from './mergeRequestCard';

const MAX_CHILD_PIPELINES = 10;
import type { HostingService } from './hostingService';
import { cleanLog } from './jobLogText';

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
    const links = (await this.hosting.known(repository))?.links;
    if (!links || links.kind !== 'gitlab') return false;
    return this.hosting.auth.connect(links.remote.host);
  }

  async openJobLog(repository: Repository, jobId: number, name: string, projectId?: number): Promise<void> {
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    const text = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Kleio: лог джобы ${name}` },
      () => api.jobLog(jobId, projectId),
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
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    await this.report(
      () => (approve ? api.approve(iid) : api.unapprove(iid)),
      approve ? 'аппрув поставлен' : 'аппрув снят',
    );
  }

  /** Merges after a confirmation that says what will happen; offers auto-merge while a pipeline is running. */
  async merge(repository: Repository, iid: number): Promise<void> {
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    const details = await api.mergeRequest(iid);
    const running = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running'].includes(
      details.pipeline?.status ?? '',
    );
    const now = 'Влить';
    const later = 'Влить после пайплайна';
    const status =
      details.mergeStatus && details.mergeStatus !== 'mergeable'
        ? `Статус GitLab: ${details.mergeStatus}. `
        : '';
    const choice = await vscode.window.showWarningMessage(
      `Влить !${iid} «${details.title}» в ${details.targetBranch}?`,
      {
        modal: true,
        detail:
          `${status}${running ? 'Пайплайн ещё идёт — можно влить автоматически, когда он пройдёт.' : ''}`.trim() ||
          undefined,
      },
      ...(running ? [later, now] : [now]),
    );
    if (!choice) return;
    await this.report(
      () => api.merge(iid, { whenPipelineSucceeds: choice === later }),
      choice === later ? 'MR вольётся после пайплайна' : 'MR влит',
    );
  }

  async rebase(repository: Repository, iid: number): Promise<void> {
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    await this.report(() => api.rebase(iid), 'rebase запущен на сервере');
  }

  /** Starts a manual job or a trigger job (e.g. a deploy to a stand) after a confirmation. */
  async playJob(repository: Repository, jobId: number, name: string, projectId?: number): Promise<void> {
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    const ok = await vscode.window.showInformationMessage(
      `Запустить «${name}»?`,
      { modal: true },
      'Запустить',
    );
    if (!ok) return;
    await this.report(() => api.playJob(jobId, projectId), `«${name}» запущена`);
  }

  private async report(action: () => Promise<void>, done: string): Promise<void> {
    try {
      await action();
      vscode.window.setStatusBarMessage(`Kleio: ${done}`, 4000);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `GitLab: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async retryPipeline(repository: Repository, pipelineId: number): Promise<void> {
    const api = await this.hosting.gitlab(repository, true);
    if (!api) return;
    await api.retryPipeline(pipelineId);
    vscode.window.setStatusBarMessage('Kleio: упавшие джобы перезапущены', 4000);
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
