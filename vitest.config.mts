import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
    // Each test opens a fresh in-memory PGlite and runs the migrations in beforeEach.
    // Under load (several suites at once) that can pass Vitest's 10 s default.
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src') },
  },
});
