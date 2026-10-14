import * as esbuild from 'esbuild';
import sveltePlugin from 'esbuild-svelte';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
};

const extension = {
  ...common,
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
};

const webview = {
  ...common,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: production ? false : 'inline',
  mainFields: ['svelte', 'browser', 'module', 'main'],
  conditions: ['svelte', 'browser', 'production'],
  loader: { '.ttf': 'file' },
  assetNames: '[name]',
  plugins: [sveltePlugin({ compilerOptions: { css: 'external', dev: !production } })],
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
