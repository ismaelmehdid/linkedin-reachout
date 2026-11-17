import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubTestEnv } from '@/test-utils/env';

/** A fresh evaluation of the module, as Next dev does for route handlers and pages or after a hot reload. */
async function loadClient() {
  vi.resetModules();
  return import('./client');
}

describe('getDb', () => {
  beforeEach(stubTestEnv);
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { __reachoutDb?: unknown }).__reachoutDb;
  });

  it('opens the database once even when the module is evaluated again', async () => {
    const first = await loadClient();
    const second = await loadClient();
    const db = first.getDb();
    expect(second.getDb()).toBe(db);
    await db;
  });
  it('opens again after a failed open', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { getDb } = await loadClient();
    const failed = getDb();
    await expect(failed).rejects.toThrow('Missing environment variables: DATABASE_URL');
    stubTestEnv();
    const retried = getDb();
    expect(retried).not.toBe(failed);
    await expect(retried).resolves.toBeDefined();
  });
  it('creates the missing parent folders of a PGlite directory, as on a fresh checkout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'reachout-db-'));
    try {
      const dataDir = path.join(root, '.data', 'dev');
      vi.stubEnv('DATABASE_URL', `pglite:${dataDir}`);
      const db = await (await loadClient()).getDb();
      await (db as unknown as { $client: PGlite }).$client.close();
      expect(existsSync(path.join(dataDir, 'PG_VERSION'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
