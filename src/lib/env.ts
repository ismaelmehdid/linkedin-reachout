export type Env = {
  unipileDsn: string;
  unipileApiKey: string;
  unipileAccountId: string;
  databaseUrl: string;
  appPassword: string;
  cronSecret: string;
  webhookSecret: string;
  dryRun: boolean;
};

const REQUIRED = [
  ['UNIPILE_DSN', 'unipileDsn'],
  ['UNIPILE_API_KEY', 'unipileApiKey'],
  ['UNIPILE_ACCOUNT_ID', 'unipileAccountId'],
  ['DATABASE_URL', 'databaseUrl'],
  ['APP_PASSWORD', 'appPassword'],
  ['CRON_SECRET', 'cronSecret'],
  ['WEBHOOK_SECRET', 'webhookSecret'],
] as const;

/** The request filter applies the same minimum, so it is defined once here. */
export const APP_PASSWORD_MIN_LENGTH = 16;

/** The app is public: a guessable secret gives away the dashboard, the tick pacing or the webhook. */
const MIN_LENGTHS = [
  ['APP_PASSWORD', APP_PASSWORD_MIN_LENGTH],
  ['CRON_SECRET', 32],
  ['WEBHOOK_SECRET', 32],
] as const;

/**
 * Every value is trimmed: a space or line break pasted with a secret would otherwise make it silently
 * wrong. `DRY_RUN` is required and must say `true` or `false`, so that a typo or a missing variable
 * fails every request instead of switching the app to live sending.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const read = (name: string) => source[name]?.trim() ?? '';
  const missing = [...REQUIRED.map(([name]) => name), 'DRY_RUN'].filter((name) => read(name) === '');
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
  const dryRun = read('DRY_RUN').toLowerCase();
  if (dryRun !== 'true' && dryRun !== 'false') {
    throw new Error('DRY_RUN must be "true" or "false"');
  }
  const short = MIN_LENGTHS.filter(([name, min]) => read(name).length < min);
  if (short.length > 0) {
    const list = short.map(([name, min]) => `${name} (min ${min})`).join(', ');
    throw new Error(`Environment variables too short: ${list}. Generate each with: openssl rand -base64 32`);
  }
  const values = Object.fromEntries(REQUIRED.map(([name, key]) => [key, read(name)]));
  return { ...(values as Omit<Env, 'dryRun'>), dryRun: dryRun === 'true' };
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
