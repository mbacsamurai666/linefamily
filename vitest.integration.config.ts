import { defineConfig } from 'vitest/config';

// Integration tests spin up a PGlite instance each, so they run serially and
// get a longer timeout than the unit suite.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
