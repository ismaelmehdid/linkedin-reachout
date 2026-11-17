import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { stubTestEnv, TEST_ENV } from '@/test-utils/env';
import { POST } from './route';

const HOOK = TEST_ENV.WEBHOOK_SECRET;

const post = (headers: Record<string, string>, body: string, handler: typeof POST = POST) =>
  handler(new Request('http://localhost/api/webhooks/unipile', { method: 'POST', headers, body }));

describe('POST /api/webhooks/unipile', () => {
  beforeAll(stubTestEnv);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers 401 without exactly Unipile-Auth: <WEBHOOK_SECRET>', async () => {
    const unauthorized: Record<string, string>[] = [
      {}, { 'unipile-auth': `${HOOK}x` }, { 'unipile-auth': `Bearer ${HOOK}` }, { authorization: `Bearer ${HOOK}` },
    ];
    for (const headers of unauthorized) {
      const response = await post(headers, '{}');
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
  });
  it('answers 400 to a body that is not JSON', async () => {
    expect((await post({ 'unipile-auth': HOOK }, 'not json')).status).toBe(400);
  });
  it('processes an authorized event and answers its outcome', async () => {
    const response = await post({ 'unipile-auth': HOOK }, JSON.stringify({ event: 'message_read' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'ignored' });
  });
  it('answers 500 misconfigured, naming nothing, and logs why while a variable is missing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('WEBHOOK_SECRET', '');
    try {
      vi.resetModules();
      const fresh = await import('./route');
      const response = await post({ 'unipile-auth': HOOK }, '{}', fresh.POST);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'misconfigured' });
      expect(errors).toHaveBeenCalledWith(expect.any(String), 'Missing environment variables: WEBHOOK_SECRET');
    } finally {
      stubTestEnv();
    }
  });
});
