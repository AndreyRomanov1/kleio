import * as vscode from 'vscode';
import { GitLabApi, GitLabApiError } from './gitlabApi';

/** Provider registered by the GitLab Workflow extension; it shares its accounts with scope `api`. */
const WORKFLOW_PROVIDER = 'gitlab';
const SCOPES = ['api'];
const SECRET_PREFIX = 'grove.gitlab.token:';
const WORKFLOW_EXTENSION = 'gitlab.gitlab-workflow';
const WORKFLOW_ACTIVATION_TIMEOUT_MS = 20_000;

export interface TokenSource {
  token: string;
  /** Where the token comes from, shown to the user. */
  origin: 'workflow' | 'grove';
}

/**
 * Finds a token for a GitLab host: an account of the GitLab Workflow extension, so nothing has to be set up
 * twice, or a personal access token stored by Grove. Each repository asks for its own host, so several
 * GitLab instances on one machine work side by side.
 */
export class GitLabAuth implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private workflowActivation?: Promise<void>;
  private readonly disposables: vscode.Disposable[];

  /** Fires when a token may have appeared or disappeared, so views reload. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.disposables = [
      this.changed,
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === WORKFLOW_PROVIDER) this.changed.fire();
      }),
      vscode.commands.registerCommand('grove.gitlab.connect', (host?: string) => this.connect(host)),
      vscode.commands.registerCommand('grove.gitlab.disconnect', () => this.disconnect()),
    ];
  }

  /**
   * A token without asking anything: Grove's own token, or a GitLab Workflow account the user already allowed
   * Grove to use. `interactive` may show VS Code's consent dialog for the GitLab Workflow account.
   */
  async token(host: string, interactive = false): Promise<TokenSource | undefined> {
    const own = await this.secrets.get(SECRET_PREFIX + host);
    if (own) return { token: own, origin: 'grove' };
    const session = await this.workflowSession(host, interactive);
    return session ? { token: session.accessToken, origin: 'workflow' } : undefined;
  }

  /** Whether the GitLab Workflow extension has an account for the host, even if Grove may not use it yet. */
  async hasWorkflowAccount(host: string): Promise<boolean> {
    return (await this.workflowAccount(host)) !== undefined;
  }

  /** Asks for access: first the GitLab Workflow account, then Grove's own token. */
  async connect(host?: string): Promise<boolean> {
    host ??= await vscode.window.showInputBox({
      title: 'Подключить GitLab',
      prompt: 'Адрес сервера GitLab',
      placeHolder: 'gitlab.com или git.example.com',
    });
    host = host?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!host) return false;

    if (await this.hasWorkflowAccount(host)) {
      const session = await this.workflowSession(host, true);
      if (session) {
        this.changed.fire();
        return true;
      }
    }
    return this.askToken(host);
  }

  private async askToken(host: string): Promise<boolean> {
    const create = 'Создать токен в браузере';
    const paste = 'У меня есть токен';
    const choice = await vscode.window.showInformationMessage(
      `Нужен доступ к ${host}`,
      {
        modal: true,
        detail:
          'Grove использует личный токен GitLab со scope api. Если стоит расширение GitLab Workflow и в нём есть аккаунт этого сервера, Grove возьмёт доступ оттуда — тогда токен не нужен.',
      },
      create,
      paste,
    );
    if (!choice) return false;
    if (choice === create) {
      const page = `https://${host}/-/user_settings/personal_access_tokens?name=Grove&scopes=api`;
      await vscode.env.openExternal(vscode.Uri.parse(page, true));
    }
    const token = await vscode.window.showInputBox({
      title: `Токен GitLab для ${host}`,
      prompt: 'Личный токен со scope api',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return false;
    try {
      const user = await new GitLabApi(host, '', token.trim()).currentUser();
      await this.secrets.store(SECRET_PREFIX + host, token.trim());
      this.changed.fire();
      void vscode.window.showInformationMessage(`Grove: подключено к ${host} как ${user.username}.`);
      return true;
    } catch (error) {
      const message =
        error instanceof GitLabApiError && error.unauthorized
          ? 'GitLab не принял токен.'
          : `Не удалось проверить токен: ${error instanceof Error ? error.message : String(error)}`;
      void vscode.window.showErrorMessage(`Grove: ${message}`);
      return false;
    }
  }

  private async disconnect(): Promise<void> {
    const host = await vscode.window.showInputBox({
      title: 'Удалить токен GitLab из Grove',
      prompt: 'Адрес сервера GitLab',
    });
    if (!host) return;
    await this.secrets.delete(SECRET_PREFIX + host.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    this.changed.fire();
  }

  private async workflowSession(
    host: string,
    interactive: boolean,
  ): Promise<vscode.AuthenticationSession | undefined> {
    const account = await this.workflowAccount(host);
    if (!account) return undefined;
    try {
      return interactive
        ? await vscode.authentication.getSession(WORKFLOW_PROVIDER, SCOPES, { account, createIfNone: true })
        : await vscode.authentication.getSession(WORKFLOW_PROVIDER, SCOPES, { account, silent: true });
    } catch {
      return undefined;
    }
  }

  /** GitLab Workflow labels its accounts `username - https://instance`. */
  private async workflowAccount(
    host: string,
  ): Promise<vscode.AuthenticationSessionAccountInformation | undefined> {
    try {
      await this.workflowReady();
      const accounts = await vscode.authentication.getAccounts(WORKFLOW_PROVIDER);
      return accounts.find((a) => {
        const url = a.label.split(' - ').pop() ?? '';
        try {
          return new URL(url).hostname === host;
        } catch {
          return false;
        }
      });
    } catch {
      return undefined;
    }
  }

  /**
   * After a reload Grove may start before GitLab Workflow, whose authentication provider is then not registered
   * yet and its accounts look missing. Activating it first (or waiting for it) avoids that race.
   */
  private workflowReady(): Promise<void> {
    this.workflowActivation ??= (async () => {
      const extension = vscode.extensions.getExtension(WORKFLOW_EXTENSION);
      if (!extension || extension.isActive) return;
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, WORKFLOW_ACTIVATION_TIMEOUT_MS));
      await Promise.race([Promise.resolve(extension.activate()).then(() => undefined), timeout]);
    })().catch(() => undefined);
    return this.workflowActivation;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
