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
  /** Kills git after this time, for commands in the background that nobody waits for. */
  timeoutMs?: number;
  /** Kills git when aborted, e.g. by the cancel button of a progress notification. */
  signal?: AbortSignal;
}

let defaultGitPath = 'git';

/**
 * Settings of the user that would change output Kleio parses or patches it applies: diffs without `a/` and
 * `b/` prefixes or in color, signatures printed into the log.
 */
const FIXED_CONFIG = [
  'core.quotepath=off',
  'color.ui=false',
  'color.diff=false',
  'diff.noprefix=false',
  'diff.mnemonicPrefix=false',
  'log.showSignature=false',
].flatMap((setting) => ['-c', setting]);

/** Sets the git executable for runners created without their own, e.g. from the `git.path` setting. */
export function setGitPath(gitPath: string): void {
  defaultGitPath = gitPath;
}

/** A finished git command, for the log of Kleio. */
export interface GitCommandRecord {
  args: readonly string[];
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  /** Whether the exit code counts as a failure for the caller. */
  failed: boolean;
  stderr: string;
}

let environment: NodeJS.ProcessEnv = {};

/** Variables every git command gets, e.g. the program that asks for passwords in the editor. */
export function setGitEnvironment(env: NodeJS.ProcessEnv): void {
  environment = env;
}

let logger: ((record: GitCommandRecord) => void) | undefined;

/** Receives every finished git command; the extension writes them to its output channel. */
export function setGitLogger(log: ((record: GitCommandRecord) => void) | undefined): void {
  logger = log;
}

const versions = new Map<string, Promise<number[]>>();

export class GitRunner {
  constructor(
    readonly cwd: string,
    private readonly explicitGitPath?: string,
  ) {}

  private get gitPath(): string {
    return this.explicitGitPath ?? defaultGitPath;
  }

  /** Whether git is at least of this version, for options that older versions reject. */
  async atLeast(major: number, minor: number): Promise<boolean> {
    const [actualMajor = 0, actualMinor = 0] = await this.version();
    return actualMajor > major || (actualMajor === major && actualMinor >= minor);
  }

  /** Major, minor and patch of git, empty when it does not run. */
  version(): Promise<number[]> {
    let version = versions.get(this.gitPath);
    if (!version) {
      version = this.run(['version']).then(
        (output) => (/(\d+)\.(\d+)(?:\.(\d+))?/.exec(output) ?? []).slice(1).map((n) => Number(n ?? 0)),
        () => [],
      );
      versions.set(this.gitPath, version);
    }
    return version;
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
      const child = this.spawn(args, options.env);

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
      const kill = () => child.kill();
      options.signal?.addEventListener('abort', kill);
      const started = Date.now();
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', kill);
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
        const ok = code === 0 || (code !== null && !!options.allowExitCodes?.includes(code));
        this.log(args, started, code, !ok, err);
        if (ok) {
          resolve({ stdout: out, stderr: err });
        } else {
          const stopped = options.signal?.aborted ? t('cancelled') : t('timed out');
          reject(new GitError(args, code, err || (code === null ? stopped : '')));
        }
      });

      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }

  /** Runs git and returns raw stdout bytes, for file contents in arbitrary encodings. */
  runBuffer(args: readonly string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(args);
      const started = Date.now();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        this.log(args, started, code, code !== 0, Buffer.concat(stderr).toString('utf8'));
        if (code === 0) resolve(Buffer.concat(stdout));
        else reject(new GitError(args, code, Buffer.concat(stderr).toString('utf8')));
      });
    });
  }

  private log(
    args: readonly string[],
    started: number,
    exitCode: number | null,
    failed: boolean,
    stderr: string,
  ) {
    logger?.({ args, cwd: this.cwd, durationMs: Date.now() - started, exitCode, failed, stderr });
  }

  private spawn(args: readonly string[], env?: NodeJS.ProcessEnv) {
    return spawn(this.gitPath, [...FIXED_CONFIG, ...args], {
      cwd: this.cwd,
      env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
      windowsHide: true,
    });
  }
}
