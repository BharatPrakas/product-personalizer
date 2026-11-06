import { defineConfig } from 'vitest/config';

// Integration tests share one Miniflare-backed D1 database per file, so run files sequentially to
// avoid truncate races (each test file gets its own Miniflare instance; see test/helpers.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
