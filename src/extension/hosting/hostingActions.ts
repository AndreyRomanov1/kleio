import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Ref } from '../../shared/model';
import { parseRevisionUri, REVISION_SCHEME } from '../content/revisionUri';
import type { Repository } from '../git/repository';
import type { RepositoryManager } from '../git/repositoryManager';
import type { HostingService, RepositoryHosting } from './hostingService';
import type { HostingLinks } from './hosting';

/** Opening things on GitLab/GitHub and creating merge requests, without any API access. */
export class HostingActions implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly repositories: RepositoryManager,
    private readonly hosting: HostingService,
  ) {
    this.disposables = [
      vscode.commands.registerCommand('kleio.hosting.openFile', (uri?: vscode.Uri) =>
        this.fileLink(uri, 'open'),
      ),
      vscode.commands.registerCommand('kleio.hosting.copyFileLink', (uri?: vscode.Uri) =>
        this.fileLink(uri, 'copy'),
      ),
    ];
  }

  async openUrl(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  async commit(repository: Repository, hash: string, mode: 'open' | 'copy'): Promise<void> {
    const links = await this.links(repository);
    if (links) await this.deliver(links.commit(hash), mode);
  }

  async branch(repository: Repository, ref: Ref): Promise<void> {
    const links = await this.links(repository);
    if (links) await this.openUrl(links.branch(remoteBranchName(ref)));
  }

  async mergeRequest(repository: Repository, number: number): Promise<void> {
    const links = await this.links(repository);
    if (links) await this.openUrl(links.mergeRequest(number));
  }

  /**
   * Opens the merge request form for the branch. An unpushed branch is pushed first; on GitLab the push itself
   * creates the merge request (push options), so it opens ready.
   */
  async createMergeRequest(repository: Repository, ref: Ref): Promise<void> {
    const hosting = await this.hosting.hosting(repository);
    const links = hosting?.links;
    if (!hosting || !links) return this.noHosting();
    const source = remoteBranchName(ref);
    const target = hosting.defaultBranch?.slice(hosting.remoteName.length + 1) ?? 'master';
    if (source === target) {
      void vscode.window.showInformationMessage(`${source} — основная ветка, MR из неё не создают.`);
      return;
    }

    const existing = hosting.mergeRequests[ref.hash]?.[0];
    if (existing) {
      const open = await vscode.window.showInformationMessage(
        `Для ${source} уже есть MR !${existing}.`,
        'Открыть MR',
      );
      if (open) await this.openUrl(links.mergeRequest(existing));
      return;
    }

    const unpushed = ref.kind === 'head' && (!ref.upstream || (ref.ahead ?? 0) > 0);
    if (!unpushed) return this.openUrl(links.newMergeRequest(source, target));

    const pushAndCreate = links.kind === 'gitlab' ? 'Отправить и создать MR' : 'Отправить и открыть форму';
    const formOnly = 'Только открыть форму';
    const choice = await vscode.window.showInformationMessage(
      ref.upstream
        ? `В ${source} есть неотправленные коммиты.`
        : `Ветка ${source} ещё не отправлена в ${hosting.remoteName}.`,
      { modal: true, detail: `MR будет в ${target}.` },
      pushAndCreate,
      formOnly,
    );
    if (choice === formOnly) return this.openUrl(links.newMergeRequest(source, target));
    if (choice !== pushAndCreate) return;

    const args = ['push', '--set-upstream', hosting.remoteName, source];
    if (links.kind === 'gitlab')
      args.push('-o', 'merge_request.create', '-o', `merge_request.target=${target}`);
    const output = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Kleio: push ${source}` },
      () => repository.git.runWithOutput(args),
    );
    this.repositories.notifyChanged(repository);
    // GitLab answers a push with the address of the merge request it created or offers to create.
    const created = /https?:\/\/\S+\/merge_requests\/\d+/.exec(output.stderr)?.[0];
    await this.openUrl(created ?? links.newMergeRequest(source, target));
  }

  private async fileLink(uri: vscode.Uri | undefined, mode: 'open' | 'copy'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const target = uri ?? editor?.document.uri;
    if (!target) return;
    let repository: Repository | undefined;
    let filePath: string;
    let revision: string | undefined;
    if (target.scheme === REVISION_SCHEME) {
      const query = parseRevisionUri(target);
      repository = await this.repositories.get(query.root);
      filePath = query.path;
      revision = query.rev;
    } else {
      repository = this.repositories.repositoryFor(target);
      if (!repository) return;
      filePath = path.relative(repository.root, target.fsPath).split(path.sep).join('/');
    }
    if (!repository) return;
    const hosting = await this.hosting.known(repository);
    if (!hosting?.links) return this.noHosting();
    revision ??= await this.publishedRevision(repository, hosting);

    let lines: { start: number; end: number } | undefined;
    if (editor && editor.document.uri.toString() === target.toString()) {
      const { start, end } = editor.selection;
      const last = end.character === 0 && end.line > start.line ? end.line : end.line + 1;
      lines = { start: start.line + 1, end: Math.max(start.line + 1, last) };
    }
    await this.deliver(hosting.links.file(revision, filePath, lines), mode);
  }

  /**
   * A revision the server knows: the current commit when it is pushed (a permanent link), otherwise the upstream
   * or the default branch.
   */
  private async publishedRevision(repository: Repository, hosting: RepositoryHosting): Promise<string> {
    const head = await repository.head();
    if (head.hash) {
      const containing = await repository.git.run(['branch', '-r', '--contains', head.hash], {
        allowExitCodes: [129],
      });
      if (containing.trim()) return head.hash;
    }
    const upstream = await repository.git.run(['rev-parse', '--abbrev-ref', '@{u}'], {
      allowExitCodes: [128],
    });
    const branch = upstream.trim() || hosting.defaultBranch;
    return branch ? branch.slice(branch.indexOf('/') + 1) : (head.hash ?? 'HEAD');
  }

  private async links(repository: Repository): Promise<HostingLinks | undefined> {
    const links = (await this.hosting.known(repository))?.links;
    if (!links) this.noHosting();
    return links;
  }

  private async deliver(url: string, mode: 'open' | 'copy'): Promise<void> {
    if (mode === 'open') return this.openUrl(url);
    await vscode.env.clipboard.writeText(url);
    vscode.window.setStatusBarMessage('Kleio: ссылка скопирована', 3000);
  }

  private noHosting(): void {
    void vscode.window.showInformationMessage(
      'Не удалось определить GitLab или GitHub по адресу remote. Для своего сервера укажите его в настройке kleio.hosting.instances.',
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** Branch name on the server: `origin/feature` → `feature`, local branches as they are. */
function remoteBranchName(ref: Ref): string {
  return ref.kind === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name;
}
