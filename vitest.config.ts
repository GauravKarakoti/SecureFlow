import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // cli/** is included so the pre-commit hook's detector is covered by the
    // same `npm test` the husky hook already runs. Coverage `include` below is
    // deliberately left at src/**, so the CLI does not move the thresholds.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'cli/src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/app/**', 'src/components/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@': import.meta.dirname + '/src',
      '__mocks__': import.meta.dirname + '/__mocks__',
    },
  },
});
