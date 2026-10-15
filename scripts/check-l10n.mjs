// Checks that every translation has exactly the messages of the code: each t('…') in src and each %key% of
// package.json. A new language is a pair of files, l10n/bundle.l10n.<lang>.json and package.nls.<lang>.json.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const readJson = (file) => JSON.parse(read(file));

function sources(dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.(ts|svelte)$/.test(entry.name) ? [file] : [];
  });
}

const call = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/gs;
const messages = new Set();
for (const file of sources('src')) {
  for (const match of read(file).matchAll(call)) messages.add(match[2].replace(/\\(.)/g, '$1'));
}

const manifestKeys = new Set([...read('package.json').matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));

let problems = 0;
function compare(file, expected, actual) {
  const missing = [...expected].filter((k) => !actual.has(k));
  const unused = [...actual].filter((k) => !expected.has(k));
  for (const k of missing) console.error(`${file}: missing ${JSON.stringify(k)}`);
  for (const k of unused) console.error(`${file}: not used ${JSON.stringify(k)}`);
  problems += missing.length + unused.length;
}

compare('package.nls.json', manifestKeys, new Set(Object.keys(readJson('package.nls.json'))));
for (const file of readdirSync(root).filter((f) => /^package\.nls\.[\w-]+\.json$/.test(f))) {
  compare(file, manifestKeys, new Set(Object.keys(readJson(file))));
}
for (const file of readdirSync(path.join(root, 'l10n')).filter((f) => f.endsWith('.json'))) {
  compare(`l10n/${file}`, messages, new Set(Object.keys(readJson(`l10n/${file}`))));
}

if (problems) {
  console.error(`${problems} translation problem(s)`);
  process.exit(1);
}
console.log(`Translations are complete: ${messages.size} messages, ${manifestKeys.size} manifest strings.`);
