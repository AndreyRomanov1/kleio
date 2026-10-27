import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { setGitEnvironment } from './git/gitRunner';
import { t } from '../shared/l10n';

/** Shell builtins only, as in the rebase editor: external tools may not start in the editor's environment. */
const SCRIPT = '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$KLEIO_ASKPASS_NODE" "$KLEIO_ASKPASS_MAIN" "$@"\n';

export interface Askpass extends vscode.Disposable {
  /** Shows a question of git or ssh and returns the answer, undefined when cancelled; replaceable in tests. */
  ask: (prompt: string) => Promise<string | undefined>;
}

/**
 * Questions of git and ssh — user name and password of an HTTPS remote, the passphrase of an SSH key, a new
 * host key — asked in the editor, as VS Code's own Git does: git runs a script (GIT_ASKPASS, SSH_ASKPASS)
 * that passes the question over a local socket. Git saves the answer to a credential helper, if one is set.
 */
export async function startAskpass(context: vscode.ExtensionContext): Promise<Askpass> {
  const askpass: Askpass = { ask, dispose: () => undefined };
  const id = randomBytes(8).toString('hex');
  const token = randomBytes(16).toString('hex');
  const handle =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\kleio-askpass-${id}`
      : path.join(process.env.XDG_RUNTIME_DIR || tmpdir(), `kleio-askpass-${id}.sock`);
  let queue = Promise.resolve();

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: { token?: string; prompt?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
      } catch {
        body = {};
      }
      if (body.token !== token) {
        response.writeHead(403).end();
        return;
      }
      // One question at a time: git asks for the user name, then for the password.
      queue = queue.then(async () => {
        const answer = await askpass.ask(body.prompt ?? '').catch(() => undefined);
        response.writeHead(answer === undefined ? 204 : 200, { 'Content-Type': 'application/json' });
        response.end(answer === undefined ? undefined : JSON.stringify({ answer }));
      });
    });
  });
  try {
    if (process.platform !== 'win32') await rm(handle, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(handle, resolve);
    });
  } catch {
    // Without the socket git and ssh fail as before, with their own messages.
    return askpass;
  }

  const storage = context.globalStorageUri.fsPath;
  await mkdir(storage, { recursive: true });
  const script = path.join(storage, 'askpass.sh');
  await writeFile(script, SCRIPT, { mode: 0o755 });
  setGitEnvironment({
    GIT_ASKPASS: script,
    SSH_ASKPASS: script,
    SSH_ASKPASS_REQUIRE: 'force',
    KLEIO_ASKPASS_NODE: process.execPath,
    KLEIO_ASKPASS_MAIN: vscode.Uri.joinPath(context.extensionUri, 'dist', 'askpass-main.js').fsPath,
    KLEIO_ASKPASS_HANDLE: handle,
    KLEIO_ASKPASS_TOKEN: token,
  });
  askpass.dispose = () => {
    setGitEnvironment({});
    server.close();
  };
  return askpass;
}

/** Asks what git or ssh asked; undefined when the user cancels. */
async function ask(prompt: string): Promise<string | undefined> {
  const question = prompt.trim().replace(/:$/, '');
  if (/\(yes\/no/i.test(question)) {
    const yes = t('Yes, connect');
    const choice = await vscode.window.showWarningMessage(
      t('Git: unknown server'),
      { modal: true, detail: question },
      yes,
    );
    return choice === yes ? 'yes' : 'no';
  }
  return vscode.window.showInputBox({
    title: 'Git',
    prompt: question,
    password: /password|passphrase|token|pin\b/i.test(question),
    ignoreFocusOut: true,
  });
}
