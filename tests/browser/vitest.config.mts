import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Browser-level tests: drive the built element bundle (dist/element) in headless Chrome.
// Run with `npm run test:browser` (builds first). Set CHROME_PATH if Chrome is not at /usr/bin/google-chrome.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['tests/browser/**/*.spec.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 90_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
