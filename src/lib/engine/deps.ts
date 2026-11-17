import type { Db } from '@/db/types';
import type { UnipileClient } from '@/lib/unipile/types';

/** Everything the engine touches from outside. Engine code reads time and randomness only from here. */
export type EngineDeps = {
  db: Db;
  unipile: UnipileClient;
  now: () => Date;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  dryRun: boolean;
};
