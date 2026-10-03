import { defineConfig } from 'vitest/config';

/**
 * End-to-end tests that run the built programs as a user would: the `mcprep` binary, the MCP server over stdio and the
 * Electron app. They need `npm run build` first (and Electron's binary for the desktop test): `npm run test:e2e`.
 */
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.e2e.test.ts', 'apps/*/test/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
