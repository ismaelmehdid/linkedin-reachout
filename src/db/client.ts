import path from 'node:path';
import { getEnv } from '@/lib/env';
import * as schema from './schema';
import type { Db } from './types';

const PGLITE_PREFIX = 'pglite:';
const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'drizzle');

let cached: Promise<Db> | undefined;

async function open(): Promise<Db> {
  const { databaseUrl } = getEnv();
  if (databaseUrl.startsWith(PGLITE_PREFIX)) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const client = new PGlite(databaseUrl.slice(PGLITE_PREFIX.length));
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db as unknown as Db;
  }
  const { neon } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-http');
  return drizzle(neon(databaseUrl), { schema }) as unknown as Db;
}

export function getDb(): Promise<Db> {
  cached ??= open().catch((error) => {
    cached = undefined;
    throw error;
  });
  return cached;
}
