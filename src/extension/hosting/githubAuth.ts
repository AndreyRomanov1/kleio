import * as vscode from 'vscode';
import { t } from '../../shared/l10n';
import { GitHubApi, GitHubApiError } from './githubApi';

const PROVIDER = 'github';
const SCOPES = ['repo'];
const SECRET_PREFIX = 'kleio.github.token:';

/**
 * Finds a token for a GitHub host: the editor's own GitHub account for github.com, which the user already
 * signed in to for settings sync or other extensions, or a personal access token stored by Kleio.
 */
export class GitHubAuth implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[];

  /** Fires when a token may have appeared or disappeared, so views reload. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.disposables = [
      this.changed,
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === PROVIDER) this.changed.fire();
      }),
      vscode.commands.registerCommand('kleio.github.connect', (host?: string) =>
        this.connect(host ?? 'github.com'),
      ),
      vscode.commands.registerCommand('kleio.github.disconnect', () => this.disconnect()),
    ];
  }

  /** A token without asking anything; `interactive` may show the sign-in of the editor's GitHub account. */
  async token(host: string, interactive = false): Promise<string | undefined> {
    const forTests = process.env.KLEIO_TEST_GITHUB_TOKEN;
    if (forTests) return forTests;
    const own = await this.secrets.get(SECRET_PREFIX + host);
    if (own) return own;
    if (host !== 'github.com') return undefined;
    try {
      const session = await vscode.authentication.getSession(
        PROVIDER,
        SCOPES,
        interactive ? { createIfNone: true } : { silent: true },
      );
      return session?.accessToken;
    } catch {
      return undefined;
    }
  }

  /** Asks for access: the editor's GitHub account on github.com, otherwise a personal access token. */
  async connect(host: string): Promise<boolean> {
    if (host === 'github.com' && (await this.token(host, true))) {
      this.changed.fire();
      return true;
    }
    const create = t('Create a token in the browser');
    const paste = t('I have a token');
    const choice = await vscode.window.showInformationMessage(
      t('Kleio needs access to {0}', host),
      {
        modal: true,
        detail: t(
          'Kleio uses a GitHub personal access token with read access to pull requests and commit statuses (the repo scope of a classic token).',
        ),
      },
      create,
      paste,
    );
    if (!choice) return false;
    if (choice === create) {
      await vscode.env.openExternal(
        vscode.Uri.parse(`https://${host}/settings/tokens/new?scopes=repo&description=Kleio`),
      );
    }
    const token = await vscode.window.showInputBox({
      title: t('GitHub token for {0}', host),
      prompt: t('Personal access token'),
      password: true,
      ignoreFocusOut: true,
    });
    if (!token?.trim()) return false;
    try {
      const login = await new GitHubApi(host, 'owner/name', token.trim()).viewer();
      await this.secrets.store(SECRET_PREFIX + host, token.trim());
      this.changed.fire();
      void vscode.window.showInformationMessage(t('Kleio: connected to {0} as {1}.', host, login));
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof GitHubApiError && error.unauthorized
          ? t('GitHub did not accept the token.')
          : t('Could not check the token: {0}', error instanceof Error ? error.message : String(error)),
      );
      return false;
    }
  }

  private async disconnect(): Promise<void> {
    const host = await vscode.window.showInputBox({
      title: t('Remove the GitHub token from Kleio'),
      prompt: t('GitHub server address'),
      value: 'github.com',
    });
    if (!host) return;
    await this.secrets.delete(SECRET_PREFIX + host.trim());
    this.changed.fire();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
