import { beforeAll, describe, expect, it } from 'vitest';
import { TICK_LEASE_MS } from '@/lib/engine/tick';
import { stubTestEnv } from '@/test-utils/env';
import { GET, maxDuration } from './route';

describe('GET /api/tick', () => {
  beforeAll(stubTestEnv);

  it('is killed before its tick lease can expire, because releaseTickLock is unconditional', () => {
    expect(maxDuration * 1000).toBeLessThan(TICK_LEASE_MS);
  });
  it('answers 401 without exactly Bearer <CRON_SECRET>', async () => {
    for (const authorization of [undefined, 'Bearer wrong', 'Bearer cronx', 'cron', 'bearer cron']) {
      const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
      const response = await GET(new Request('http://localhost/api/tick', { headers }));
      expect(response.status, String(authorization)).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
  });
});
