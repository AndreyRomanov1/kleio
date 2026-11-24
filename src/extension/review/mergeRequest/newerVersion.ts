import * as vscode from 'vscode';
import { t } from '../../../shared/l10n';
import { REVISION_SCHEME } from '../../content/revisionUri';
import { formatTime } from '../threadBoard';
import type { MergeRequestSession, NewerVersion } from './mergeRequestSession';

/**
 * The offer of a newer version while the review stays on its own: lenses above each file of the merge request,
 * an item in the status bar and a message once. Its actions are the commands `kleio.review.*`.
 */
export class NewerVersionOffer implements vscode.Disposable {
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly session: () => MergeRequestSession | undefined) {
    this.status.command = 'kleio.review.newVersion';
    this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.disposables = [
      this.lensesChanged,
      this.status,
      vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: REVISION_SCHEME }], {
        onDidChangeCodeLenses: this.lensesChanged.event,
        provideCodeLenses: (document) => this.lenses(document),
      }),
    ];
  }

  /** Shows or hides the offer; a version offered for the first time also shows a message. */
  offer(session: MergeRequestSession, newer: NewerVersion | undefined): void {
    const first = newer && session.newer?.headSha !== newer.headSha;
    session.newer = newer;
    this.update();
    if (!first) return;
    const compare = t(
      'What changed {0} → {1}',
      session.versionName(session.current),
      session.versionName(newer),
    );
    const go = t('Go to {0}', session.versionName(newer));
    void vscode.window
      .showInformationMessage(
        t(
          '!{0} has a new version {1}. You stay on {2} until you choose.',
          session.iid,
          session.versionName(newer),
          session.versionName(session.current),
        ),
        compare,
        go,
      )
      .then((choice) => {
        if (choice === compare) return vscode.commands.executeCommand('kleio.review.compareNewer');
        if (choice === go) return vscode.commands.executeCommand('kleio.review.switchToNewer');
      });
  }

  /** Redraws the offer for the review under way, or hides it when there is none. */
  update(): void {
    const session = this.session();
    const newer = session?.newer;
    this.lensesChanged.fire();
    if (!session || !newer) {
      this.status.hide();
      return;
    }
    this.status.text = `$(git-pull-request) !${session.iid} · ${session.versionName(session.current)} · ${t(
      'new {0}',
      session.versionName(newer),
    )}`;
    this.status.tooltip = t('A newer version of !{0}: choose what to do with it', session.iid);
    this.status.show();
  }

  /** The counts in the lenses changed. */
  refreshLenses(): void {
    this.lensesChanged.fire();
  }

  /** Keeps the review on its version: the lenses go, the status bar keeps the newer one at hand. */
  dismiss(): void {
    const session = this.session();
    if (!session?.newer) return;
    session.dismissed = session.newer.headSha;
    this.lensesChanged.fire();
  }

  async menu(): Promise<void> {
    const session = this.session();
    const newer = session?.newer;
    if (!session || !newer) return;
    const was = session.versionName(session.current);
    const now = session.versionName(newer);
    const items: (vscode.QuickPickItem & { command: string })[] = [
      { label: t('What changed {0} → {1}', was, now), command: 'kleio.review.compareNewer' },
      { label: t('Go to {0}', now), command: 'kleio.review.switchToNewer' },
      { label: t('Finish {0}', was), command: 'kleio.review.stayOnVersion' },
      ...(session.drafts
        ? [{ label: t('Send drafts ({0})', session.drafts), command: 'kleio.review.publishDrafts' }]
        : []),
    ];
    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: t('!{0} has a new version {1}; you are on {2}', session.iid, now, was),
    });
    if (choice) await vscode.commands.executeCommand(choice.command);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private lenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const session = this.session();
    const newer = session?.newer;
    if (!session || !newer || session.dismissed === newer.headSha) return [];
    if (session.documents.get(document.uri.toString())?.side !== 'new') return [];
    const range = new vscode.Range(0, 0, 0, 0);
    const lens = (title: string, command: string) => new vscode.CodeLens(range, { title, command });
    const time = newer.createdAt ? formatTime(newer.createdAt) : '';
    const was = session.versionName(session.current);
    const now = session.versionName(newer);
    return [
      lens(
        `$(git-pull-request) ${t('New version {0}', now)}${time ? ` · ${time}` : ''}`,
        'kleio.review.newVersion',
      ),
      lens(t('What changed {0} → {1}', was, now), 'kleio.review.compareNewer'),
      lens(t('Go to {0}', now), 'kleio.review.switchToNewer'),
      lens(t('Finish {0}', was), 'kleio.review.stayOnVersion'),
      ...(session.drafts ? [lens(t('Send drafts ({0})', session.drafts), 'kleio.review.publishDrafts')] : []),
      ...(session.newerOnly
        ? [lens(t('+{0} comments of {1}', session.newerOnly, now), 'kleio.review.switchToNewer')]
        : []),
    ];
  }
}
