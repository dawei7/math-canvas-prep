import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Tests run against the TypeScript sources (no build needed): the workspace package names are mapped to their `src`.
 * The end-to-end tests that need built output (`npm run test:e2e`) use vitest.e2e.config.ts.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@mcprep/core/pure', replacement: src('./packages/core/src/pure.ts') },
      { find: '@mcprep/core/testing', replacement: src('./packages/core/src/testing.ts') },
      { find: '@mcprep/core', replacement: src('./packages/core/src/index.ts') },
      { find: '@mcprep/cli', replacement: src('./packages/cli/src/index.ts') },
      { find: '@mcprep/mcp', replacement: src('./packages/mcp/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
