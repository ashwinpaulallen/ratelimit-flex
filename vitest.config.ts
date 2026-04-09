import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const shared = {
  environment: 'node' as const,
  passWithNoTests: true,
  coverage: {
    provider: 'v8' as const,
    reporter: ['text', 'json', 'html'] as const,
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
  },
};

export default defineConfig({
  resolve: {
    alias: {
      /** Resolve like published `ratelimit-flex/postgres` subpath (see package.json `exports`). */
      'ratelimit-flex/postgres': path.resolve(rootDir, 'src/stores/postgres/index.ts'),
    },
  },
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts', 'tests/**/*.spec.ts'],
          exclude: ['tests/cluster/cluster.integration.test.ts'],
        },
      },
      {
        test: {
          ...shared,
          name: 'cluster-integration',
          include: ['tests/cluster/cluster.integration.test.ts'],
          /** Node's `cluster` API does not work inside Vitest's default worker-thread pool. */
          pool: 'forks',
          testTimeout: 10_000,
        },
      },
    ],
  },
});
