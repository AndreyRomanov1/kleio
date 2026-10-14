import type { CommitWebviewMessage } from '../shared/commitProtocol';
import type { WebviewMessage } from '../shared/protocol';
import type { PushWebviewMessage } from '../shared/pushProtocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}

export function postCommit(message: CommitWebviewMessage): void {
  api.postMessage(message);
}

export function postPush(message: PushWebviewMessage): void {
  api.postMessage(message);
}

/** Per-view state of webviews other than the log (each webview keeps its own state). */
export function loadState<T extends object>(defaults: T): T {
  return { ...defaults, ...((api.getState() as Partial<T> | undefined) ?? {}) };
}

export function saveState(state: object): void {
  api.setState(state);
}

export interface UiState {
  /** Bumped when a default changes so that it reaches views with saved state. */
  layoutVersion: number;
  branchWidth: number;
  authorWidth: number;
  dateWidth: number;
  detailsWidth: number;
  /** Where commit details go: beside the log, under it, or chosen by the width of the view. */
  detailsPosition: 'auto' | 'right' | 'bottom';
  detailsHeight: number;
  fileView: 'tree' | 'list';
  groupByDirectory: boolean;
  showBranches: boolean;
  collapsed: string[];
}

const LAYOUT_VERSION = 2;

const defaults: UiState = {
  layoutVersion: LAYOUT_VERSION,
  branchWidth: 240,
  authorWidth: 64,
  dateWidth: 100,
  detailsWidth: 380,
  detailsHeight: 260,
  detailsPosition: 'auto',
  fileView: 'tree',
  groupByDirectory: true,
  showBranches: true,
  collapsed: ['section:tags'],
};

export function loadUiState(): UiState {
  const saved = (api.getState() as Partial<UiState> | undefined) ?? {};
  const state = { ...defaults, ...saved };
  if ((saved.layoutVersion ?? 1) < 2) state.authorWidth = defaults.authorWidth;
  state.layoutVersion = LAYOUT_VERSION;
  return state;
}

export function saveUiState(state: UiState): void {
  api.setState(state);
}
