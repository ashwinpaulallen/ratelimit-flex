import { defineConfig } from 'vitest/config';

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
