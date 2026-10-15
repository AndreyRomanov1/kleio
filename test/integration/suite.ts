import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { commitChangeSet } from '../../src/extension/changes/changeSet';
import type { KleioApi } from '../../src/extension/extension';
import { REVISION_SCHEME, revisionUri } from '../../src/extension/content/revisionUri';

type Test = [name: string, body: (api: KleioApi) => Promise<void>];

const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeout = 5000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`);
    await wait(50);
  }
}

function activeDiff(): vscode.TabInputTextDiff | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff ? input : undefined;
}

async function headChangeSet(api: KleioApi) {
  const repository = await api.repositories.get(root());
  assert.ok(repository, 'repository is found');
  const head = await repository.commitDetails('HEAD');
  return commitChangeSet(repository, head.hash, head.parents);
}

const tests: Test[] = [
  [
    'finds the workspace repository',
    async (api) => {
      assert.deepEqual(
        api.repositories.all.map((r) => path.basename(r.root)),
        [path.basename(root())],
      );
    },
  ],
  [
    'reads file contents of a revision',
    async () => {
      const document = await vscode.workspace.openTextDocument(revisionUri(root(), 'HEAD~1', 'a.txt'));
      assert.equal(document.uri.scheme, REVISION_SCHEME);
      assert.equal(document.lineAt(4).text, 'line 5');
      assert.equal(document.languageId, 'plaintext');
    },
  ],
  [
    'opens a commit diff with the editable working file on the right',
    async (api) => {
      const changeSet = await headChangeSet(api);
      assert.deepEqual(
        changeSet.files.map((f) => `${f.status} ${f.path}`),
        ['M a.txt', 'M b.txt', 'A c.txt', 'M greeter.ts'],
      );
      await api.navigator.open(changeSet, 0);
      const diff = await waitFor(activeDiff, 'diff editor');
      assert.equal(diff.original.scheme, REVISION_SCHEME);
      assert.equal(diff.modified.scheme, 'file', 'unchanged-since-commit file is opened as the real file');
      const editor = await waitFor(() => vscode.window.activeTextEditor, 'active editor');
      assert.equal(editor.selection.active.line, 4, 'cursor starts at the first change');
    },
  ],
  [
    'F7 walks through changes and, pressed twice at the end, continues into the next file',
    async (api) => {
      await vscode.workspace
        .getConfiguration('workbench.editor')
        .update('enablePreview', false, vscode.ConfigurationTarget.Global);
      const diffOf = (name: string) => () => {
        const diff = activeDiff();
        return diff && path.basename(diff.modified.fsPath) === name ? diff : undefined;
      };
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(root(), 'b.txt')), { preview: false });
      await api.navigator.open(await headChangeSet(api), 0);
      await waitFor(activeDiff, 'diff editor');
      const diffIndex = () => vscode.window.tabGroups.activeTabGroup.tabs.findIndex((t) => t.isActive);
      const initialIndex = diffIndex();
      await vscode.commands.executeCommand('kleio.diff.nextChange');
      assert.equal(vscode.window.activeTextEditor?.selection.active.line, 24, 'second change of a.txt');

      await vscode.commands.executeCommand('kleio.diff.nextChange');
      await wait(300);
      assert.ok(diffOf('a.txt')(), 'the first press at the last change stays in the file');
      await vscode.commands.executeCommand('kleio.diff.nextChange');
      await waitFor(diffOf('b.txt'), 'diff of b.txt after the second press');

      const diffTabs = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => t.input instanceof vscode.TabInputTextDiff);
      assert.equal(diffTabs.length, 1, 'the diff of a.txt is replaced, not kept in another tab');
      assert.equal(diffIndex(), initialIndex, 'the new diff takes the place of the old one');

      await vscode.commands.executeCommand('kleio.diff.previousChange');
      await vscode.commands.executeCommand('kleio.diff.previousChange');
      await waitFor(diffOf('a.txt'), 'back to a.txt');
      await waitFor(
        () => vscode.window.activeTextEditor?.selection.active.line === 24 || undefined,
        'last change of a.txt',
      );
    },
  ],
  [
    'shows an added file against an empty left side',
    async (api) => {
      await api.navigator.open(await headChangeSet(api), 2);
      const diff = await waitFor(activeDiff, 'diff editor');
      const left = await vscode.workspace.openTextDocument(diff.original);
      assert.equal(left.getText(), '');
    },
  ],
  [
    'annotates a file with blame and follows unsaved edits',
    async (api) => {
      const uri = vscode.Uri.file(path.join(root(), 'a.txt'));
      const editor = await vscode.window.showTextDocument(uri);
      await vscode.commands.executeCommand('kleio.blame.show');
      const lines = await waitFor(() => api.blame.linesOf(uri), 'blame annotations');
      assert.equal(lines.length, 30);
      assert.equal(lines[4].commit.summary, 'second');
      assert.equal(lines[0].commit.summary, 'initial');

      await editor.edit((e) => e.insert(new vscode.Position(0, 0), 'inserted\n'));
      await waitFor(() => (api.blame.linesOf(uri)?.length === 31 ? true : undefined), 'blame after an edit');
      assert.equal(api.blame.linesOf(uri)![0].commit.hash, '0'.repeat(40));
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await vscode.commands.executeCommand('kleio.blame.hide');
      assert.equal(api.blame.linesOf(uri), undefined);
    },
  ],
  [
    'opens the history of a file in a tab and the diff of a file from a blame link',
    async () => {
      await vscode.commands.executeCommand('kleio.history.file', vscode.Uri.file(path.join(root(), 'b.txt')));
      const tab = await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputWebview && input.viewType.endsWith('kleio.history')
          ? input
          : undefined;
      }, 'history tab');
      assert.ok(tab);

      const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root(), encoding: 'utf8' }).trim();
      await vscode.commands.executeCommand('kleio.blame.showCommit', { root: root(), hash, path: 'b.txt' });
      await waitFor(() => {
        const diff = activeDiff();
        return diff && path.basename(diff.modified.fsPath) === 'b.txt' ? diff : undefined;
      }, 'diff of b.txt from the blame link');
    },
  ],
  [
    'shows the main author and the number of other authors above declarations',
    async () => {
      const uri = vscode.Uri.file(path.join(root(), 'greeter.ts'));
      await vscode.window.showTextDocument(uri);
      const titles = await waitFor(
        async () => {
          const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider',
            uri,
            10,
          );
          const own = lenses
            .filter((l) => l.command?.command === 'kleio.blame.toggle')
            .map((l) => l.command!.title);
          return own.length >= 2 ? own : undefined;
        },
        'author lenses',
        20000,
      );
      assert.deepEqual(titles, ['$(person) Kleio Test +1', '$(person) Kleio Test +1']);
    },
  ],
  [
    'reviews a GitLab merge request: threads in the code, comments with positions, drafts and the journal',
    async (api) => {
      const repository = await api.repositories.get(root());
      assert.ok(repository);
      const origin = process.env.KLEIO_TEST_GITLAB_ORIGIN!;
      const requests = async () =>
        (await (await fetch(`${origin}/__requests`)).json()) as { method: string; url: string; body?: any }[];

      await api.review.start(repository, 1, 'a.txt', 25);
      const diff = await waitFor(activeDiff, 'merge request diff');
      assert.equal(path.basename(diff.modified.fsPath), 'a.txt');
      const [existing] = await waitFor(
        () => (api.review.openThreads().length ? api.review.openThreads() : undefined),
        'threads',
      );
      assert.equal(existing.line, 25);
      assert.equal(existing.uri, diff.modified.toString());
      assert.deepEqual(existing.comments, ['Почему так?']);

      const modified = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === diff.modified.toString(),
      )!;
      modified.selection = new vscode.Selection(0, 0, 0, 0);
      await vscode.commands.executeCommand('kleio.review.nextComment');
      assert.equal(modified.selection.active.line, 24, 'next review comment is the thread on line 25');

      // A comment typed on a changed line and on an unchanged one: GitLab needs one or both line numbers.
      const thread = (uri: vscode.Uri, line: number) => ({
        uri,
        range: new vscode.Range(line - 1, 0, line - 1, 0),
        comments: [],
        dispose() {},
      });
      await vscode.commands.executeCommand('kleio.review.publish', {
        thread: thread(diff.modified, 5),
        text: 'Изменённая строка',
      });
      await vscode.commands.executeCommand('kleio.review.draft', {
        thread: thread(diff.modified, 10),
        text: 'Черновик',
      });
      let sent = (await requests()).filter((r) => r.method === 'POST');
      assert.deepEqual(sent[0].body.position.new_line, 5);
      assert.equal(sent[0].body.position.old_line, undefined);
      assert.equal(sent[0].body.body, 'Изменённая строка');
      assert.deepEqual([sent[1].body.position.old_line, sent[1].body.position.new_line], [10, 10]);
      assert.ok(sent[1].url.endsWith('/draft_notes'));
      await waitFor(
        () => (api.review.openThreads().some((t) => t.label === 'Draft') ? true : undefined),
        'draft thread',
      );

      await vscode.commands.executeCommand('kleio.review.publishDrafts');
      sent = (await requests()).filter((r) => r.method === 'POST');
      assert.ok(sent.at(-1)!.url.endsWith('/draft_notes/bulk_publish'));
      await waitFor(
        () => (api.review.openThreads().length === 3 ? true : undefined),
        'three published threads',
      );

      await vscode.commands.executeCommand('kleio.review.openJournal');
      const journal = vscode.window.activeTextEditor!.document.getText();
      assert.match(journal, /"text":"Изменённая строка"/);
      assert.match(journal, /"status":"sent"/);
      await vscode.commands.executeCommand('kleio.review.end');
    },
  ],
  [
    'opens the push dialog for the current branch',
    async () => {
      await vscode.commands.executeCommand('kleio.git.push');
      const tab = await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputWebview && input.viewType.endsWith('kleio.push')
          ? input
          : undefined;
      }, 'push dialog tab');
      assert.ok(tab);
    },
  ],
  [
    'opens the interactive rebase dialog for commits of the current branch',
    async (api) => {
      const repository = await api.repositories.get(root());
      assert.ok(repository);
      const head = await repository.commitDetails('HEAD');
      await api.rebase.open(repository, { kind: 'reword', hash: head.hash });
      await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputWebview && input.viewType.endsWith('kleio.rebase')
          ? input
          : undefined;
      }, 'rebase dialog tab');
    },
  ],
  [
    'merges a conflicted file in the merge editor: saving keeps the conflict, completing resolves it',
    async (api) => {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root(), encoding: 'utf8' });
      const file = path.join(root(), 'limit.txt');
      const write = (text: string) => require('node:fs').writeFileSync(file, text);
      const source = (body: string) => `class Limit {\n  calc(amount) {\n    return ${body};\n  }\n}\n`;
      write(source('amount * 0.9'));
      git('add', 'limit.txt');
      git('commit', '-q', '-m', 'limit');
      git('checkout', '-q', '-b', 'side');
      write(source('round(amount * 0.85)'));
      git('commit', '-q', '-am', 'side');
      git('checkout', '-q', 'main');
      write(source('amount * 0.9 - fee(amount)'));
      git('commit', '-q', '-am', 'main');
      try {
        try {
          git('merge', 'side');
        } catch {
          // Stops on the conflict.
        }
        const repository = (await api.repositories.get(root()))!;
        assert.deepEqual(
          (await repository.conflicts()).map((f) => f.path),
          ['limit.txt'],
        );
        await api.conflicts.openMerge(repository, 'limit.txt');
        const merge = await waitFor(() => {
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as
            { result?: vscode.Uri; input1?: vscode.Uri } | undefined;
          return input?.result ? input : undefined;
        }, 'merge editor');
        assert.equal(merge.input1?.scheme, REVISION_SCHEME);
        // The editor loads both sides and computes the conflicts before it takes commands.
        await wait(4000);

        // A save of a file open in the merge editor does not count as resolving it.
        const document = await vscode.workspace.openTextDocument(merge.result!);
        await document.save();
        await wait(500);
        assert.equal((await repository.conflicts()).length, 1, 'saving in the merge editor does not resolve');

        await vscode.commands.executeCommand('mergeEditor.acceptAllCombination');
        await vscode.commands.executeCommand('kleio.conflicts.markResolved');
        await waitFor(
          async () => ((await repository.conflicts()).length === 0 ? true : undefined),
          'resolved',
        );
        const merged = require('node:fs').readFileSync(file, 'utf8');
        assert.match(merged, /round\(amount \* 0\.85\) - fee\(amount\)/);
        assert.equal(git('diff', '--cached', '--name-only').trim(), 'limit.txt');
      } finally {
        git('merge', '--abort');
        git('reset', '-q', '--hard', 'HEAD~2');
        git('branch', '-q', '-D', 'side');
      }
    },
  ],
  [
    'melds a commit into the previous one inside the editor environment',
    async (api) => {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root(), encoding: 'utf8' });
      const before = git('rev-parse', 'HEAD').trim();
      const write = (name: string) => require('node:fs').writeFileSync(path.join(root(), name), `${name}\n`);
      write('one.txt');
      git('add', 'one.txt');
      git('commit', '-q', '-m', 'one');
      write('two.txt');
      git('add', 'two.txt');
      git('commit', '-q', '-m', 'two');
      try {
        const repository = (await api.repositories.get(root()))!;
        await api.rebase.fixupIntoParent(repository, git('rev-parse', 'HEAD').trim());
        assert.equal(git('log', '-1', '--format=%s').trim(), 'one');
        assert.equal(git('rev-parse', 'HEAD~1').trim(), before);
        assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [
          'one.txt',
          'two.txt',
        ]);
      } finally {
        git('reset', '-q', '--hard', before);
      }
    },
  ],
  [
    'makes the repository of the active editor the current one for the log, commit view and status bar',
    async (api) => {
      const fs = require('node:fs') as typeof import('node:fs');
      const other = path.join(path.dirname(root()), `${path.basename(root())}-other`);
      fs.mkdirSync(other, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main', other]);
      fs.writeFileSync(path.join(other, 'other.txt'), 'other\n');
      const repository = await api.repositories.get(other);
      assert.ok(repository);

      await vscode.window.showTextDocument(vscode.Uri.file(path.join(other, 'other.txt')));
      await waitFor(
        () => (api.repositories.current?.root === repository.root ? true : undefined),
        'other current',
      );
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(root(), 'b.txt')));
      await waitFor(
        () => (api.repositories.current?.root === path.normalize(root()) ? true : undefined),
        'back',
      );
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    },
  ],
  [
    'checks a branch out into a new worktree next to the repository and copies listed files',
    async (api) => {
      const fs = require('node:fs') as typeof import('node:fs');
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root(), encoding: 'utf8' });
      const target = path.join(path.dirname(root()), `${path.basename(root())}-feature-wt`);
      git('branch', 'feature/wt');
      fs.writeFileSync(path.join(root(), 'local.json'), '{"secret": 1}\n');
      await vscode.workspace
        .getConfiguration('kleio')
        .update('worktree.copyFiles', ['local.json', 'missing.json'], vscode.ConfigurationTarget.Global);
      try {
        const repository = (await api.repositories.get(root()))!;
        const snapshot = await repository.snapshot();
        const ref = snapshot.refs.find((r) => r.name === 'feature/wt')!;
        void api.actions.checkoutToWorktree(repository, snapshot, ref);
        await wait(1000);
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        await waitFor(() => (fs.existsSync(path.join(target, 'local.json')) ? true : undefined), 'worktree');
        assert.equal(
          execFileSync('git', ['branch', '--show-current'], { cwd: target, encoding: 'utf8' }).trim(),
          'feature/wt',
        );
      } finally {
        await vscode.workspace
          .getConfiguration('kleio')
          .update('worktree.copyFiles', undefined, vscode.ConfigurationTarget.Global);
        if (fs.existsSync(target)) git('worktree', 'remove', '--force', target);
        git('branch', '-q', '-D', 'feature/wt');
        fs.rmSync(path.join(root(), 'local.json'));
      }
    },
  ],
  [
    'opens the log in an editor tab',
    async (api) => {
      const panel = api.logs.openInEditor();
      assert.equal(panel.viewType, 'kleio.logPanel');
      await wait(500);
      panel.dispose();
    },
  ],
];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<KleioApi>('aroma.kleio');
  assert.ok(extension, 'extension is installed');
  const api = await extension.activate();

  const failures: string[] = [];
  for (const [name, body] of tests) {
    try {
      await body(api);
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(
        `  ✗ ${name}\n    ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  }
  console.log(`\n${tests.length - failures.length}/${tests.length} passed`);
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed`);
}
