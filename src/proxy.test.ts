import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from '@/lib/auth/session';
import { TEST_ENV } from '@/test-utils/env';
import { config, proxy } from './proxy';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = TEST_ENV.APP_PASSWORD;

const request = (path: string, token?: string) =>
  new NextRequest(`${ORIGIN}${path}`, token === undefined ? {} : { headers: { cookie: `${SESSION_COOKIE}=${token}` } });

const passes = (response: Response) => response.headers.get('x-middleware-next') === '1';

describe('proxy', () => {
  beforeAll(() => {
    vi.stubEnv('APP_PASSWORD', PASSWORD);
  });

  it('runs on every path but static files, image optimization and the favicon', () => {
    for (const url of ['/', '/login', '/settings', '/api/tick', '/api/leads', '/next.svg']) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
    }
    for (const url of ['/_next/static/chunks/main.js', '/_next/image?url=%2Fnext.svg&w=64&q=75', '/favicon.ico']) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(false);
    }
  });
  it('lets the three public paths through without a session', async () => {
    for (const path of ['/login', '/api/tick', '/api/webhooks/unipile']) expect(passes(await proxy(request(path))), path).toBe(true);
  });
  it('redirects pages to /login and answers 401 on the API without a valid session', async () => {
    const expired = await createSessionToken(PASSWORD, new Date(Date.now() - SESSION_TTL_MS - 1));
    const otherPassword = await createSessionToken('previous-app-password', new Date());
    for (const token of [undefined, 'garbage', expired, otherPassword]) {
      const page = await proxy(request('/settings', token));
      expect(page.status).toBe(307);
      expect(page.headers.get('location')).toBe(`${ORIGIN}/login`);
      const api = await proxy(request('/api/leads', token));
      expect(api.status).toBe(401);
      expect(await api.json()).toEqual({ error: 'unauthorized' });
    }
  });
  it('lets a valid session through', async () => {
    const token = await createSessionToken(PASSWORD, new Date());
    for (const path of ['/', '/settings', '/api/leads']) expect(passes(await proxy(request(path, token))), path).toBe(true);
  });
  it('lets nobody through while APP_PASSWORD is unset', async () => {
    const token = await createSessionToken(PASSWORD, new Date());
    vi.stubEnv('APP_PASSWORD', '');
    try {
      expect((await proxy(request('/settings', token))).status).toBe(307);
    } finally {
      vi.stubEnv('APP_PASSWORD', PASSWORD);
    }
  });
  it('lets nobody through while APP_PASSWORD is shorter than 16 characters, even with a session signed by it', async () => {
    const short = 'fifteen-chars-0';
    const token = await createSessionToken(short, new Date());
    vi.stubEnv('APP_PASSWORD', short);
    try {
      expect((await proxy(request('/settings', token))).status).toBe(307);
      expect((await proxy(request('/api/leads', token))).status).toBe(401);
    } finally {
      vi.stubEnv('APP_PASSWORD', PASSWORD);
    }
  });
  it('reads APP_PASSWORD without the spaces around it, as the login does', async () => {
    const token = await createSessionToken(PASSWORD, new Date());
    vi.stubEnv('APP_PASSWORD', `  ${PASSWORD}\n`);
    try {
      expect(passes(await proxy(request('/settings', token)))).toBe(true);
    } finally {
      vi.stubEnv('APP_PASSWORD', PASSWORD);
    }
  });
});
