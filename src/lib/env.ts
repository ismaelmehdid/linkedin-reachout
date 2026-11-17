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

/** The app is public: a guessable secret gives away the dashboard, the tick pacing or the webhook. */
const MIN_LENGTHS = [
  ['APP_PASSWORD', 16],
  ['CRON_SECRET', 32],
  ['WEBHOOK_SECRET', 32],
] as const;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const missing = REQUIRED.filter(([name]) => !source[name]).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
  const short = MIN_LENGTHS.filter(([name, min]) => (source[name] as string).length < min);
  if (short.length > 0) {
    const list = short.map(([name, min]) => `${name} (min ${min})`).join(', ');
    throw new Error(`Environment variables too short: ${list}. Generate each with: openssl rand -base64 32`);
  }
  const values = Object.fromEntries(REQUIRED.map(([name, key]) => [key, source[name] as string]));
  return { ...(values as Omit<Env, 'dryRun'>), dryRun: source.DRY_RUN === 'true' };
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
