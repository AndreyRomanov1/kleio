/**
 * Development preview of the log UI in a regular browser, backed by a real repository.
 * Serves dist/webview.* with a fake VS Code API and answers webview messages over HTTP.
 *
 *   npm run preview -- /path/to/repo [port]
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import * as path from 'node:path';
import type { HostMessage, WebviewMessage } from '../../src/shared/protocol';
import { commitChangeSet, describeRange, rangeChangeSet } from '../../src/extension/changes/changeSet';
import { Repository } from '../../src/extension/git/repository';

const repoPath = process.argv[2] ?? process.cwd();
const port = Number(process.argv[3] ?? 5173);
const dist = path.resolve(__dirname, '..');
const page = readFileSync(path.resolve(__dirname, '../../scripts/preview/index.html'), 'utf8');

let focus: string[] = [];
let favorites: string[] = [];
let changeSetId = 0;

async function handle(repository: Repository, message: WebviewMessage): Promise<HostMessage[]> {
  switch (message.type) {
    case 'ready':
    case 'refresh':
    case 'setFocus':
    case 'toggleFavorite': {
      if (message.type === 'setFocus') focus = message.revisions;
      if (message.type === 'toggleFavorite') {
        favorites = favorites.includes(message.fullName)
          ? favorites.filter((f) => f !== message.fullName)
          : [...favorites, message.fullName];
      }
      const started = Date.now();
      const snapshot = await repository.snapshot({ revisions: focus });
      console.log(`snapshot: ${snapshot.commits.length} commits in ${Date.now() - started} ms`);
      return [
        {
          type: 'snapshot',
          repositories: [{ root: repository.root, name: repository.name }],
          snapshot,
          focus,
          favorites,
        },
      ];
    }
    case 'selectCommits':
    case 'showStash': {
      const hashes = message.type === 'showStash' ? [message.hash] : message.hashes;
      const commits = await Promise.all(hashes.map((h) => repository.commitDetails(h)));
      const newest = commits[0];
      const oldest = commits[commits.length - 1];
      const changeSet =
        commits.length === 1
          ? await commitChangeSet(repository, newest.hash, newest.parents)
          : await rangeChangeSet(repository, oldest.parents[0], newest.hash, 'Несколько коммитов');
      return [
        {
          type: 'details',
          requestId: message.requestId,
          commits,
          changeSet: {
            id: ++changeSetId,
            title: changeSet.title,
            range: describeRange(changeSet),
            files: changeSet.files,
          },
        },
      ];
    }
    default:
      console.log('ignored in preview:', message.type);
      return [];
  }
}

async function main(): Promise<void> {
  const repository = await Repository.open(repoPath);
  if (!repository) throw new Error(`Not a git repository: ${repoPath}`);

  createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0];
    if (request.method === 'POST' && url === '/message') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        handle(repository, JSON.parse(body) as WebviewMessage)
          .then((messages) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(messages));
          })
          .catch((error: unknown) => {
            console.error(error);
            response.statusCode = 500;
            response.end(String(error));
          });
      });
      return;
    }
    if (url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(page);
      return;
    }
    const types: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.ttf': 'font/ttf',
    };
    const type = types[path.extname(url)];
    try {
      const content = type ? readFileSync(path.join(dist, path.basename(url))) : undefined;
      if (!content) throw new Error('not found');
      response.setHeader('Content-Type', type);
      response.end(content);
    } catch {
      response.statusCode = 404;
      response.end();
    }
  }).listen(port, () => console.log(`Preview of ${repository.root}: http://localhost:${port}`));
}

void main();
