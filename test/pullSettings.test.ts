import { beforeEach, expect, it, vi } from 'vitest';
import type { Repository } from '../src/extension/git/repository';

const ui = vi.hoisted(() => ({
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
  showWarningMessage: vi.fn(),
  setStatusBarMessage: vi.fn(),
}));
vi.mock('vscode', () => ({ window: ui }));
import { PullSettings, pullStrategy } from '../src/extension/actions/pullSettings';

/** A git config of two scopes; local values win, as in git. */
function fixture(local: Record<string, string> = {}, global: Record<string, string> = {}) {
  const scopes = { local: new Map(Object.entries(local)), global: new Map(Object.entries(global)) };
  const writes: string[][] = [];
  const repository = {
    git: {
      run: vi.fn(async (args: string[]) => {
        if (args[1] === '--show-scope') {
          for (const scope of ['local', 'global'] as const) {
            const value = scopes[scope].get(args[3]);
            if (value !== undefined) return `${scope}\t${value}\n`;
          }
          return '';
        }
        const scope = scopes[args[1] === '--global' ? 'global' : 'local'];
        if (args[2] === '--get') return scope.get(args[3]) ?? '';
        writes.push(args);
        if (args[2] === '--unset') scope.delete(args[3]);
        else scope.set(args[2], args[3]);
        return '';
      }),
    },
  } as unknown as Repository;
  return { scopes, writes, settings: new PullSettings(repository) };
}

beforeEach(() => {
  vi.resetAllMocks();
});

it('follows git pull: a branch rule first, then pull.rebase, then pull.ff', () => {
  expect(pullStrategy({})).toBeUndefined();
  expect(pullStrategy({ pullRebase: 'true' })).toBe('rebase');
  expect(pullStrategy({ pullRebase: 'merges' })).toBe('rebase');
  expect(pullStrategy({ branchRebase: 'false', pullRebase: 'true' })).toBe('merge');
  expect(pullStrategy({ pullFf: 'only' })).toBe('ff-only');
  expect(pullStrategy({ pullRebase: 'false', pullFf: 'only' })).toBe('ff-only');
  expect(pullStrategy({ pullFf: 'false' })).toBe('merge');
});

it('tells where the effective rule comes from', async () => {
  const { settings } = fixture({ 'branch.main.rebase': 'false' }, { 'pull.rebase': 'true' });
  expect(await settings.rule('main')).toEqual({
    strategy: 'merge',
    key: 'branch.main.rebase',
    scope: 'local',
  });
  expect(await fixture({}, { 'pull.rebase': 'true' }).settings.rule('main')).toEqual({
    strategy: 'rebase',
    key: 'pull.rebase',
    scope: 'global',
  });
});

it('saves the answer for diverged histories only in the repository config', async () => {
  const { settings, writes } = fixture();
  ui.showInformationMessage.mockResolvedValueOnce('Rebase');
  expect(await settings.askWhenDiverged('main', 'origin/main', 2, 5)).toBe(true);
  expect(writes).toEqual([['config', '--local', 'pull.rebase', 'true']]);
  expect(await settings.rule('main')).toMatchObject({ strategy: 'rebase', scope: 'local' });
});

it('writes nothing when the question is dismissed', async () => {
  const { settings, writes } = fixture();
  ui.showInformationMessage.mockResolvedValueOnce(undefined);
  expect(await settings.askWhenDiverged('main', 'origin/main', 2, 5)).toBe(false);
  expect(writes).toEqual([]);
});

it('saves a chosen strategy globally only when asked, replacing fast-forward only', async () => {
  const { settings, scopes } = fixture({}, { 'pull.ff': 'only' });
  ui.showQuickPick
    .mockImplementationOnce(async (items) => items.find((i: { label: string }) => i.label === 'Merge'))
    .mockImplementationOnce(async (items) => items.find((i: { flag: string }) => i.flag === '--global'));
  await settings.choose('main');
  expect(Object.fromEntries(scopes.global)).toEqual({ 'pull.rebase': 'false' });
  expect(scopes.local.size).toBe(0);
  expect(ui.showWarningMessage).not.toHaveBeenCalled();
});

it('warns when a repository rule still overrides the global choice', async () => {
  const { settings } = fixture({ 'pull.rebase': 'true' });
  ui.showQuickPick
    .mockImplementationOnce(async (items) => items.find((i: { label: string }) => i.label === 'Merge'))
    .mockImplementationOnce(async (items) => items.find((i: { flag: string }) => i.flag === '--global'));
  await settings.choose('main');
  expect(ui.showWarningMessage).toHaveBeenCalledOnce();
});

it('changes the branch rule in place without asking where to save', async () => {
  const { settings, scopes } = fixture({ 'branch.main.rebase': 'true' });
  ui.showQuickPick.mockImplementationOnce(async (items) =>
    items.find((i: { label: string }) => i.label === 'Merge'),
  );
  await settings.choose('main');
  expect(ui.showQuickPick).toHaveBeenCalledOnce();
  expect(scopes.local.get('branch.main.rebase')).toBe('false');
});
