/** An exception no handler caught inside a webview, sent to the extension to be logged. */
export interface WebviewErrorMessage {
  type: 'webviewError';
  error: string;
}
