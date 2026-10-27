import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { GitRunner, setGitLogger, type GitCommandRecord } from './git/gitRunner';
import { t } from '../shared/l10n';

/** Oldest git Kleio opens repositories with: `rev-parse --path-format=absolute`. */
const MIN_GIT = [2, 31];
/** Git that has everything Kleio uses: `rebase --update-refs`, `merge-tree --write-tree`. */
const FULL_GIT = [2, 38];
const MAX_ARGS_LENGTH = 400;

/**
 * The Kleio output channel: every git command with its duration, failures with what git said. Successful
 * commands are debug messages, shown once the log level of the channel is lowered.
 */
export function createOutput(): { channel: vscode.LogOutputChannel; disposable: vscode.Disposable } {
  const channel = vscode.window.createOutputChannel('Kleio', { log: true });
  setGitLogger((record) => log(channel, record));
  const show = vscode.commands.registerCommand('kleio.showLog', () => channel.show());
  return {
    channel,
    disposable: vscode.Disposable.from(channel, show, { dispose: () => setGitLogger(undefined) }),
  };
}

function log(channel: vscode.LogOutputChannel, record: GitCommandRecord): void {
  let command = `git ${record.args.join(' ')}`;
  if (command.length > MAX_ARGS_LENGTH) command = `${command.slice(0, MAX_ARGS_LENGTH)}…`;
  const line = `${hideCredentials(command)} (${record.durationMs} ms, ${record.cwd})`;
  if (!record.failed) {
    channel.debug(line);
    return;
  }
  const exit = record.exitCode === null ? 'killed' : `exit ${record.exitCode}`;
  channel.warn(`${line} — ${exit}\n${hideCredentials(record.stderr.trim())}`);
}

/** User names and tokens in URLs, e.g. `https://user:token@host/…`, are never written out. */
export function hideCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
}

/** Says once at the start when git does not run or is too old for Kleio. */
export async function checkGit(channel: vscode.LogOutputChannel): Promise<void> {
  const version = await new GitRunner(homedir()).version();
  if (version.length === 0) {
    channel.error('git does not run');
    void vscode.window.showErrorMessage(
      t('Kleio could not run git. Install git or point the git.path setting to it.'),
    );
    return;
  }
  const text = version.join('.');
  channel.info(`git ${text}`);
  if (older(version, MIN_GIT)) {
    void vscode.window.showErrorMessage(
      t(
        'Kleio needs git {0} or newer, and git {1} is installed: repositories are not opened.',
        MIN_GIT.join('.'),
        text,
      ),
    );
  } else if (older(version, FULL_GIT)) {
    channel.warn(
      `git ${text}: stacked branches in a rebase and the versions of a merge request after a rebase need git ${FULL_GIT.join('.')}`,
    );
  }
}

function older(version: number[], than: number[]): boolean {
  const [major = 0, minor = 0] = version;
  return major < than[0] || (major === than[0] && minor < than[1]);
}
