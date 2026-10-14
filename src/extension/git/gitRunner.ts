import { spawn } from 'node:child_process';

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
}

export class GitRunner {
  constructor(
    readonly cwd: string,
    private readonly gitPath = 'git',
  ) {}

  run(args: readonly string[], options: RunOptions = {}): Promise<string> {
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
      child.on('error', reject);
      child.on('close', (code) => {
        const out = Buffer.concat(stdout).toString('utf8');
        if (code === 0 || (code !== null && options.allowExitCodes?.includes(code))) {
          resolve(out);
        } else {
          reject(new GitError(args, code, Buffer.concat(stderr).toString('utf8')));
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
