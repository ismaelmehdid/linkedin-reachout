import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const full = {
  UNIPILE_DSN: 'api1.unipile.com:13111', UNIPILE_API_KEY: 'k', UNIPILE_ACCOUNT_ID: 'acc_1',
  DATABASE_URL: 'pglite:./.data/dev', APP_PASSWORD: 'pw', CRON_SECRET: 'cron', WEBHOOK_SECRET: 'hook',
};

describe('parseEnv', () => {
  it('parses every variable', () => {
    expect(parseEnv(full)).toEqual({
      unipileDsn: 'api1.unipile.com:13111', unipileApiKey: 'k', unipileAccountId: 'acc_1',
      databaseUrl: 'pglite:./.data/dev', appPassword: 'pw', cronSecret: 'cron', webhookSecret: 'hook', dryRun: false,
    });
  });

  it('reads DRY_RUN=true as true and any other value as false', () => {
    expect(parseEnv({ ...full, DRY_RUN: 'true' }).dryRun).toBe(true);
    expect(parseEnv({ ...full, DRY_RUN: '1' }).dryRun).toBe(false);
  });

  it('lists every missing variable in one error, empty strings included', () => {
    expect(() => parseEnv({ UNIPILE_DSN: 'x', UNIPILE_API_KEY: '' })).toThrow(
      'Missing environment variables: UNIPILE_API_KEY, UNIPILE_ACCOUNT_ID, DATABASE_URL, APP_PASSWORD, CRON_SECRET, WEBHOOK_SECRET',
    );
  });
});
