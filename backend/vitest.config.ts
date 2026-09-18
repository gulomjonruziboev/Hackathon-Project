import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
