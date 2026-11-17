import { getDb } from '@/db/client';
import type { EngineDeps } from '@/lib/engine/deps';
import { getEnv } from '@/lib/env';
import { createUnipileClient } from '@/lib/unipile/client';
import { createDryRunClient } from '@/lib/unipile/dry-run';

/** The engine's real dependencies: the place where the real clock, randomness and Unipile enter. */
export async function createEngineDeps(): Promise<EngineDeps> {
  const env = getEnv();
  const unipile = createUnipileClient({ dsn: env.unipileDsn, apiKey: env.unipileApiKey, accountId: env.unipileAccountId });
  return {
    db: await getDb(),
    unipile: env.dryRun ? createDryRunClient(unipile) : unipile,
    now: () => new Date(),
    random: Math.random,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    dryRun: env.dryRun,
  };
}
