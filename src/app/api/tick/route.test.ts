import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TICK_LEASE_MS } from '@/lib/engine/tick';
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

  it('is killed before its tick lease can expire, because releaseTickLock is unconditional', () => {
    expect(maxDuration * 1000).toBeLessThan(TICK_LEASE_MS);
  });
  it('answers 401 without exactly Bearer <CRON_SECRET>', async () => {
    for (const authorization of [undefined, 'Bearer wrong', `Bearer ${CRON}x`, CRON, `bearer ${CRON}`]) {
      const response = await tick(GET, authorization);
      expect(response.status, String(authorization)).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
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
