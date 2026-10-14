import type { WebviewMessage } from '../shared/protocol';

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

export interface UiState {
  branchWidth: number;
  authorWidth: number;
  dateWidth: number;
  detailsWidth: number;
  detailsHeight: number;
  fileView: 'tree' | 'list';
  groupByDirectory: boolean;
  showBranches: boolean;
  collapsed: string[];
}

const defaults: UiState = {
  branchWidth: 240,
  authorWidth: 110,
  dateWidth: 100,
  detailsWidth: 380,
  detailsHeight: 260,
  fileView: 'tree',
  groupByDirectory: true,
  showBranches: true,
  collapsed: ['section:tags'],
};

export function loadUiState(): UiState {
  return { ...defaults, ...((api.getState() as Partial<UiState> | undefined) ?? {}) };
}

export function saveUiState(state: UiState): void {
  api.setState(state);
}
