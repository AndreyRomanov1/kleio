import { afterEach, expect, it, vi } from 'vitest';
import { cardRequest } from '../src/extension/hosting/cardRequest';

afterEach(() => vi.useRealTimers());

it('turns failures before or after fetching card details into a response for the webview', async () => {
  expect(
    await cardRequest(() => {
      throw new Error('authentication failed');
    }),
  ).toEqual({ error: 'authentication failed' });
  expect(
    await cardRequest(async () => {
      throw new Error('versions failed');
    }),
  ).toEqual({ error: 'versions failed' });
});

it('returns a retryable error when loading never resolves', async () => {
  vi.useFakeTimers();
  const result = cardRequest(() => new Promise(() => {}), 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toEqual({
    error: 'Loading the merge request timed out. Check your connection and retry.',
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('cleans up its deadline after a normal response', async () => {
  vi.useFakeTimers();
  expect(await cardRequest(async () => ({ needsAuth: true }))).toEqual({ needsAuth: true });
  expect(vi.getTimerCount()).toBe(0);
});

it('a result arriving after the deadline cannot replace the timeout response', async () => {
  vi.useFakeTimers();
  let finish!: (value: { needsAuth: true }) => void;
  const result = cardRequest(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    100,
  );
  await vi.advanceTimersByTimeAsync(100);
  const timedOut = await result;
  finish({ needsAuth: true });
  await Promise.resolve();
  expect(await result).toEqual(timedOut);
  expect(timedOut).toHaveProperty('error');
});
