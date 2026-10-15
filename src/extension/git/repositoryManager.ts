import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Repository } from './repository';

const WATCHED_GIT_FILES =
  '{HEAD,ORIG_HEAD,FETCH_HEAD,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,packed-refs,refs/**,worktrees/*/HEAD,rebase-merge,rebase-merge/msgnum,rebase-apply,rebase-apply/next}';
const REFRESH_DELAY_MS = 400;

/** Finds repositories of the workspace folders and reports changes to their refs. */
export class RepositoryManager implements vscode.Disposable {
  private readonly repositories = new Map<string, Repository>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly changed = new vscode.EventEmitter<Repository>();
  private readonly listChanged = new vscode.EventEmitter<void>();
  private readonly currentChanged = new vscode.EventEmitter<Repository>();
  private currentRoot?: string;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeRepository = this.changed.event;
  readonly onDidChangeRepositories = this.listChanged.event;
  /** The repository the log, the commit view and the status bar show changed. */
  readonly onDidChangeCurrent = this.currentChanged.event;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.scan()),
      // As in Rider, a file of another repository opened in the editor makes that repository the current one.
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const uri = editor?.document.uri;
        const repository = uri?.scheme === 'file' ? this.repositoryFor(uri) : undefined;
        if (repository) this.setCurrent(repository);
      }),
      this.changed,
      this.listChanged,
      this.currentChanged,
    );
  }

  /** The repository being worked with: chosen by the user or of the active editor; the first one at start. */
  get current(): Repository | undefined {
    return (this.currentRoot && this.repositories.get(this.currentRoot)) || this.initial();
  }

  setCurrent(repository: Repository): void {
    if (this.currentRoot === repository.root) return;
    if (!this.repositories.has(repository.root)) this.add(repository);
    this.currentRoot = repository.root;
    this.currentChanged.fire(repository);
  }

  private initial(): Repository | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri?.scheme === 'file' ? this.repositoryFor(uri) : undefined) ?? this.all[0];
  }

  get all(): Repository[] {
    return [...this.repositories.values()];
  }

  async scan(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const found = (await Promise.all(folders.map((f) => openFolder(f.uri.fsPath)))).flat();
    let changed = false;
    for (const repository of found) {
      if (repository && !this.repositories.has(repository.root)) {
        this.add(repository);
        changed = true;
      }
    }
    if (changed) this.listChanged.fire();
  }

  /** Returns a known repository by its root, opening it on demand (e.g. another worktree). */
  async get(root: string): Promise<Repository | undefined> {
    const known = this.repositories.get(path.normalize(root));
    if (known) return known;
    const repository = await Repository.open(root);
    if (repository && !this.repositories.has(repository.root)) this.add(repository);
    return repository;
  }

  repositoryFor(uri: vscode.Uri): Repository | undefined {
    const file = uri.fsPath;
    let best: Repository | undefined;
    for (const repository of this.repositories.values()) {
      const relative = path.relative(repository.root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      if (!best || repository.root.length > best.root.length) best = repository;
    }
    return best;
  }

  /** Forces listeners to reload, e.g. after a git command run by Kleio itself. */
  notifyChanged(repository: Repository): void {
    this.scheduleRefresh(repository);
  }

  private add(repository: Repository): void {
    this.repositories.set(repository.root, repository);
    const watchers = [repository.commonDir, repository.gitDir]
      .filter((dir, index, all) => all.indexOf(dir) === index)
      .map((dir) =>
        vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(dir), WATCHED_GIT_FILES),
        ),
      );
    for (const watcher of watchers) {
      const refresh = () => this.scheduleRefresh(repository);
      watcher.onDidChange(refresh);
      watcher.onDidCreate(refresh);
      watcher.onDidDelete(refresh);
    }
    this.watchers.set(repository.root, vscode.Disposable.from(...watchers));
  }

  private scheduleRefresh(repository: Repository): void {
    clearTimeout(this.pending.get(repository.root));
    this.pending.set(
      repository.root,
      setTimeout(() => {
        this.pending.delete(repository.root);
        this.changed.fire(repository);
      }, REFRESH_DELAY_MS),
    );
  }

  dispose(): void {
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    for (const watcher of this.watchers.values()) watcher.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** The repository of a folder, or, for a folder outside of git, the repositories right inside it. */
async function openFolder(folder: string): Promise<(Repository | undefined)[]> {
  const own = await Repository.open(folder);
  if (own) return [own];
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const nested = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const candidates = await Promise.all(
    nested.map(async (e) => {
      const dir = path.join(folder, e.name);
      const hasGit = await readdir(dir).then(
        (names) => names.includes('.git'),
        () => false,
      );
      return hasGit ? Repository.open(dir) : undefined;
    }),
  );
  return candidates;
}
