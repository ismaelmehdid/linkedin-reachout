import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getEnv } from '@/lib/env';
import * as schema from './schema';
import type { Db } from './types';

const PGLITE_PREFIX = 'pglite:';
const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'drizzle');

/**
 * The open database is kept on globalThis, not in module scope: in Next dev a module can be evaluated more
 * than once (route handlers and pages, or after a hot reload), and a second `new PGlite()` on the same
 * folder must never happen.
 */
const memo = globalThis as typeof globalThis & { __reachoutDb?: Promise<Db> };

async function open(): Promise<Db> {
  const { databaseUrl } = getEnv();
  if (databaseUrl.startsWith(PGLITE_PREFIX)) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const dataDir = databaseUrl.slice(PGLITE_PREFIX.length);
    // PGlite creates its own folder but not missing parents, such as the git-ignored `.data/` of a fresh
    // checkout. `memory://` and other schemes are not folders.
    if (!dataDir.includes('://')) await mkdir(dataDir, { recursive: true });
    const client = new PGlite(dataDir);
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db as unknown as Db;
  }
  const { neon } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-http');
  return drizzle(neon(databaseUrl), { schema }) as unknown as Db;
}

/** The shared database. A failed open is forgotten, so the next call tries again. */
export function getDb(): Promise<Db> {
  memo.__reachoutDb ??= open().catch((error) => {
    memo.__reachoutDb = undefined;
    throw error;
  });
  return memo.__reachoutDb;
}
