import { beforeAll, describe, expect, it } from 'vitest';
import { stubTestEnv } from '@/test-utils/env';
import { POST } from './route';

const post = (headers: Record<string, string>, body: string) =>
  POST(new Request('http://localhost/api/webhooks/unipile', { method: 'POST', headers, body }));

describe('POST /api/webhooks/unipile', () => {
  beforeAll(stubTestEnv);

  it('answers 401 without exactly Unipile-Auth: <WEBHOOK_SECRET>', async () => {
    const unauthorized: Record<string, string>[] = [
      {}, { 'unipile-auth': 'hookx' }, { 'unipile-auth': 'Bearer hook' }, { authorization: 'Bearer hook' },
    ];
    for (const headers of unauthorized) {
      const response = await post(headers, '{}');
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
  });
  it('answers 400 to a body that is not JSON', async () => {
    expect((await post({ 'unipile-auth': 'hook' }, 'not json')).status).toBe(400);
  });
  it('processes an authorized event and answers its outcome', async () => {
    const response = await post({ 'unipile-auth': 'hook' }, JSON.stringify({ event: 'message_read' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'ignored' });
  });
});
