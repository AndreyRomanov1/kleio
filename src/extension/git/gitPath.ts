import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { setGitPath } from './gitRunner';

/** Runs the git that VS Code's own Git uses: the first existing path from `git.path`, or `git` from PATH. */
export function watchGitPath(): vscode.Disposable {
  const apply = () => {
    const value = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
    const candidates = Array.isArray(value) ? value : value ? [value] : [];
    setGitPath(candidates.find((candidate) => existsSync(candidate)) ?? 'git');
  };
  apply();
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('git.path')) apply();
  });
}
