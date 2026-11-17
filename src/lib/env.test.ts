import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const full = {
  UNIPILE_DSN: 'api1.unipile.com:13111', UNIPILE_API_KEY: 'k', UNIPILE_ACCOUNT_ID: 'acc_1',
  DATABASE_URL: 'pglite:./.data/dev', APP_PASSWORD: 'correct-horse-battery', CRON_SECRET: 'c'.repeat(32), WEBHOOK_SECRET: 'w'.repeat(32),
  DRY_RUN: 'false',
};

const parsed = {
  unipileDsn: 'api1.unipile.com:13111', unipileApiKey: 'k', unipileAccountId: 'acc_1',
  databaseUrl: 'pglite:./.data/dev', appPassword: 'correct-horse-battery', cronSecret: 'c'.repeat(32),
  webhookSecret: 'w'.repeat(32), dryRun: false,
};

describe('parseEnv', () => {
  it('parses every variable', () => {
    expect(parseEnv(full)).toEqual(parsed);
  });

  it('trims every value, so a pasted space or line break changes nothing', () => {
    const padded = Object.fromEntries(Object.entries(full).map(([name, value]) => [name, `  ${value}\n`]));
    expect(parseEnv(padded)).toEqual(parsed);
  });

  it('reads DRY_RUN as true or false, in any letter case', () => {
    for (const value of ['true', 'TRUE', 'True', ' true ']) expect(parseEnv({ ...full, DRY_RUN: value }).dryRun, value).toBe(true);
    for (const value of ['false', 'FALSE', 'False']) expect(parseEnv({ ...full, DRY_RUN: value }).dryRun, value).toBe(false);
  });

  it('refuses any other DRY_RUN value instead of running live', () => {
    for (const value of ['1', '0', 'yes', 'no', 'on', 'tru', 'true!', 'dry']) {
      expect(() => parseEnv({ ...full, DRY_RUN: value }), value).toThrow('DRY_RUN must be "true" or "false"');
    }
  });

  it('lists every missing variable in one error, empty strings and DRY_RUN included', () => {
    expect(() => parseEnv({ UNIPILE_DSN: 'x', UNIPILE_API_KEY: '' })).toThrow(
      'Missing environment variables: UNIPILE_API_KEY, UNIPILE_ACCOUNT_ID, DATABASE_URL, APP_PASSWORD, CRON_SECRET, WEBHOOK_SECRET, DRY_RUN',
    );
    const withoutDryRun: Record<string, string> = { ...full };
    delete withoutDryRun.DRY_RUN;
    expect(() => parseEnv(withoutDryRun)).toThrow('Missing environment variables: DRY_RUN');
  });

  it('counts a value of only spaces as missing', () => {
    expect(() => parseEnv({ ...full, UNIPILE_API_KEY: '   ', DRY_RUN: ' \n' })).toThrow('Missing environment variables: UNIPILE_API_KEY, DRY_RUN');
  });

  it('lists every secret that is too short in one error, with how to generate one', () => {
    expect(() => parseEnv({ ...full, APP_PASSWORD: 'short', WEBHOOK_SECRET: 'hook' })).toThrow(
      'Environment variables too short: APP_PASSWORD (min 16), WEBHOOK_SECRET (min 32). Generate each with: openssl rand -base64 32',
    );
  });

  it('measures a secret without the spaces around it', () => {
    expect(() => parseEnv({ ...full, APP_PASSWORD: `  ${'p'.repeat(15)}  ` })).toThrow('Environment variables too short: APP_PASSWORD (min 16)');
  });

  it('accepts a secret of exactly the minimum length', () => {
    expect(parseEnv({ ...full, APP_PASSWORD: 'p'.repeat(16) }).appPassword).toBe('p'.repeat(16));
  });
});
