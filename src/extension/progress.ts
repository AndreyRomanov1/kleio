import * as vscode from 'vscode';

/**
 * A notification with a cancel button for a network command: it takes as long as the network does, and the
 * user decides when to give up, instead of a fixed timeout.
 */
export function withCancellableProgress<T>(
  title: string,
  task: (signal: AbortSignal, progress: vscode.Progress<{ message?: string }>) => Promise<T>,
): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      return task(controller.signal, progress);
    },
  );
}
