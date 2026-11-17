import { describe, expect, it } from 'vitest';
import { createSessionToken, isAuthorizedBearer, isPublicPath, safeEqual, SESSION_TTL_MS, verifySessionToken } from './session';

const NOW = new Date('2026-11-17T09:00:00Z');

describe('session tokens', () => {
  it('accepts a fresh token and rejects it after 30 days', async () => {
    const token = await createSessionToken('s3cret', NOW);
    expect(await verifySessionToken(token, 's3cret', NOW)).toBe(true);
    expect(await verifySessionToken(token, 's3cret', new Date(NOW.getTime() + SESSION_TTL_MS + 1))).toBe(false);
  });
  it('rejects another secret, a tampered expiry and malformed tokens', async () => {
    const token = await createSessionToken('s3cret', NOW);
    expect(await verifySessionToken(token, 'other', NOW)).toBe(false);
    expect(await verifySessionToken(`${NOW.getTime() + 10 * SESSION_TTL_MS}.${token.split('.')[1]}`, 's3cret', NOW)).toBe(false);
    for (const bad of [undefined, '', 'abc', '1.2.3']) expect(await verifySessionToken(bad, 's3cret', NOW)).toBe(false);
  });
  it('fails closed when the secret is empty', async () => {
    const token = await createSessionToken('s3cret', NOW);
    expect(await verifySessionToken(token, '', NOW)).toBe(false);
    await expect(createSessionToken('', NOW)).rejects.toThrow();
    expect(isAuthorizedBearer('Bearer ', '')).toBe(false);
  });
});

describe('request checks', () => {
  it('compares strings exactly', () => {
    expect(safeEqual('hook', 'hook')).toBe(true);
    for (const other of ['hoo', 'hookx', 'Hook', '']) expect(safeEqual(other, 'hook')).toBe(false);
  });
  it('checks bearer headers exactly', () => {
    expect(isAuthorizedBearer('Bearer cron', 'cron')).toBe(true);
    for (const header of ['Bearer cronx', 'cron', 'bearer  cron', null]) expect(isAuthorizedBearer(header, 'cron')).toBe(false);
  });
  it('lists only the three public paths', () => {
    expect(['/login', '/api/tick', '/api/webhooks/unipile'].every(isPublicPath)).toBe(true);
    expect(['/', '/settings', '/api/tick/extra', '/api/webhooks'].some(isPublicPath)).toBe(false);
  });
});
