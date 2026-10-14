// Runs test/integration in a real VS Code-compatible editor against a throwaway repository.
//
//   GROVE_CODE=/path/to/codium npm run test:integration
//
// On Linux without a display the editor is started under xvfb-run. The editor gets its own profile and
// extension directories, so a running editor of the user is not touched.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';

const code = process.env.GROVE_CODE ?? 'codium';
const projectRoot = path.resolve(import.meta.dirname, '..');

await esbuild.build({
  entryPoints: ['test/integration/suite.ts'],
  outfile: 'dist/test/suite.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
});

const work = mkdtempSync(path.join(tmpdir(), 'grove-it-'));
const repo = path.join(work, 'repo');
mkdirSync(repo);
const git = (...args) =>
  execFileSync('git', args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-01-01T10:00:00',
      GIT_COMMITTER_DATE: '2026-01-01T10:00:00',
    },
  });
const lines = (n, change = {}) =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Grove Test');
git('config', 'user.email', 'test@example.com');
writeFileSync(path.join(repo, 'a.txt'), lines(30));
writeFileSync(path.join(repo, 'b.txt'), lines(5));
git('add', '.');
git('commit', '-q', '-m', 'initial');
writeFileSync(path.join(repo, 'a.txt'), lines(30, { 5: 'changed 5', 25: 'changed 25' }));
writeFileSync(path.join(repo, 'b.txt'), lines(5, { 2: 'changed 2' }));
writeFileSync(path.join(repo, 'c.txt'), 'new file\n');
git('add', '.');
git('commit', '-q', '-m', 'second');

const editorArgs = [
  repo,
  `--extensionDevelopmentPath=${projectRoot}`,
  `--extensionTestsPath=${path.join(projectRoot, 'dist/test/suite.js')}`,
  `--user-data-dir=${path.join(work, 'user-data')}`,
  `--extensions-dir=${path.join(work, 'extensions')}`,
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-gpu',
];
if (process.platform === 'linux') editorArgs.push('--ozone-platform=x11');
const headless = process.platform === 'linux' && process.env.GROVE_HEADLESS !== '0';
const [command, args] = headless ? ['xvfb-run', ['-a', code, ...editorArgs]] : [code, editorArgs];

// Without this Electron prefers the Wayland session and shows the window on the real desktop.
const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: undefined,
  ...(headless ? { WAYLAND_DISPLAY: undefined } : {}),
};
const result = spawnSync(command, args, { stdio: 'inherit', env });
rmSync(work, { recursive: true, force: true });
process.exit(result.status ?? 1);
