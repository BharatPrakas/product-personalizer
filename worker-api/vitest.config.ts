import { defineConfig } from 'vitest/config';

// Integration tests share one local Postgres, so run files sequentially to avoid truncate races.
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
