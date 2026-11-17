import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACTION_START_BUDGET_MS, TICK_LEASE_MS } from '@/lib/engine/tick';
import { UNIPILE_TIMEOUT_MS } from '@/lib/unipile/client';
import { stubTestEnv, TEST_ENV } from '@/test-utils/env';
import { GET, maxDuration } from './route';

const CRON = TEST_ENV.CRON_SECRET;

const tick = (handler: typeof GET, authorization?: string) =>
  handler(new Request('http://localhost/api/tick', { headers: authorization === undefined ? {} : { authorization } }));

describe('GET /api/tick', () => {
  beforeAll(stubTestEnv);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is killed before its tick lease can expire, so two ticks never run at once', () => {
    expect(maxDuration * 1000).toBeLessThan(TICK_LEASE_MS);
  });
  it('leaves the slowest action time to finish before the function is killed', () => {
    // A message for a lead with no known chat makes three Unipile calls: find the chat, read it, send.
    const slowestActionMs = 3 * UNIPILE_TIMEOUT_MS;
    expect(ACTION_START_BUDGET_MS + slowestActionMs).toBeLessThan(maxDuration * 1000);
  });
  it('answers 401 without exactly Bearer <CRON_SECRET>', async () => {
    for (const authorization of [undefined, 'Bearer wrong', `Bearer ${CRON}x`, CRON, `bearer ${CRON}`]) {
      const response = await tick(GET, authorization);
      expect(response.status, String(authorization)).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
  });
  it('answers 202 and schedules the tick once the database answered', async () => {
    const after = vi.fn();
    vi.doMock('next/server', async (importOriginal) => ({ ...(await importOriginal<typeof import('next/server')>()), after }));
    try {
      vi.resetModules();
      const fresh = await import('./route');
      const response = await tick(fresh.GET, `Bearer ${CRON}`);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true });
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('next/server');
      vi.resetModules();
    }
  });
  it('answers 500 database_unreachable, and logs why, when the database cannot be read', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('neon: the compute is suspended');
    const after = vi.fn();
    vi.doMock('next/server', async (importOriginal) => ({ ...(await importOriginal<typeof import('next/server')>()), after }));
    vi.doMock('@/db/client', () => ({
      getDb: async () => {
        throw failure;
      },
    }));
    try {
      vi.resetModules();
      const fresh = await import('./route');
      const response = await tick(fresh.GET, `Bearer ${CRON}`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'database_unreachable' });
      expect(errors).toHaveBeenCalledWith(expect.any(String), failure);
      // No tick is scheduled, and the database is only read for an authorized caller.
      expect(after).not.toHaveBeenCalled();
      expect((await tick(fresh.GET, 'Bearer wrong')).status).toBe(401);
    } finally {
      vi.doUnmock('next/server');
      vi.doUnmock('@/db/client');
      vi.resetModules();
    }
  });
  it('answers 500 misconfigured, naming nothing, and logs why while a variable is missing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('CRON_SECRET', '');
    try {
      vi.resetModules();
      const fresh = await import('./route');
      const response = await tick(fresh.GET, `Bearer ${CRON}`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'misconfigured' });
      expect(errors).toHaveBeenCalledWith(expect.any(String), 'Missing environment variables: CRON_SECRET');
    } finally {
      stubTestEnv();
    }
  });
});
