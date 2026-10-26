import { defineWorkspace } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (see "source" export condition).
const resolve = { conditions: ['source'] };

export default defineWorkspace([
  {
    resolve,
    test: {
      name: 'unit',
      include: ['{apps,packages}/*/src/**/*.test.ts'],
      exclude: ['**/*.int.test.ts', '**/node_modules/**'],
    },
  },
  {
    resolve,
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.int.test.ts'],
      globalSetup: ['tests/integration/global-setup.ts'],
      // Test files share one database; run them one at a time.
      fileParallelism: false,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 20_000,
      hookTimeout: 30_000,
    },
  },
]);
