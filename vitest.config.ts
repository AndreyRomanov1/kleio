import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests that run git: a process start costs much more on Windows runners, a test takes up to ~10 s there.
    testTimeout: 30_000,
  },
});
