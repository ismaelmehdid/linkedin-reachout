import { vi } from 'vitest';

/** Every required variable, with an in-memory database and secrets long enough for `parseEnv`. */
export const TEST_ENV = {
  UNIPILE_DSN: 'api1.unipile.com:13111',
  UNIPILE_API_KEY: 'k',
  UNIPILE_ACCOUNT_ID: 'acc_1',
  DATABASE_URL: 'pglite:memory://',
  APP_PASSWORD: 'correct-horse-battery',
  CRON_SECRET: 'c'.repeat(32),
  WEBHOOK_SECRET: 'w'.repeat(32),
};

/** Stubs TEST_ENV into process.env. Call it before the first `getEnv()` of the test file: `getEnv` caches. */
export function stubTestEnv(): void {
  for (const [name, value] of Object.entries(TEST_ENV)) vi.stubEnv(name, value);
}
