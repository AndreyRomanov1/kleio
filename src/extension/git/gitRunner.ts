import { spawn } from 'node:child_process';
import { t } from '../../shared/l10n';

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(stderr.trim() || `git ${args.join(' ')} exited with code ${exitCode}`);
  }
}

export interface RunOptions {
  /** Content written to stdin. */
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Resolve instead of throwing on these exit codes. */
  allowExitCodes?: number[];
  /** Kills git after this time, e.g. for network commands that might wait for an SSH passphrase. */
  timeoutMs?: number;
}

let defaultGitPath = 'git';

/** Sets the git executable for runners created without their own, e.g. from the `git.path` setting. */
export function setGitPath(gitPath: string): void {
  defaultGitPath = gitPath;
}

export class GitRunner {
  constructor(
    readonly cwd: string,
    private readonly explicitGitPath?: string,
  ) {}

  private get gitPath(): string {
    return this.explicitGitPath ?? defaultGitPath;
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<string> {
    return (await this.runWithOutput(args, options)).stdout;
  }

  /** Like {@link run}, but also returns stderr, where git prints messages of the remote on push. */
  runWithOutput(
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], {
        cwd: this.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...options.env },
        windowsHide: true,
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
        if (code === 0 || (code !== null && options.allowExitCodes?.includes(code))) {
          resolve({ stdout: out, stderr: err });
        } else {
          reject(new GitError(args, code, err || (code === null ? t('timed out') : '')));
        }
      });

      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }

  /** Runs git and returns raw stdout bytes, for file contents in arbitrary encodings. */
  runBuffer(args: readonly string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, args, { cwd: this.cwd, windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(stdout));
        else reject(new GitError(args, code, Buffer.concat(stderr).toString('utf8')));
      });
    });
  }
}
