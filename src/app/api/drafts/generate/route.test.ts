import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/db/types';
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth/session';
import { GENERATION_DEADLINE_MS } from '@/lib/drafts/generate';
import { saveSettings } from '@/lib/settings/repo';
import { DEFAULT_SETTINGS } from '@/lib/settings/settings';
import { createTestDb } from '@/test-utils/db';
import { getLead, seedLead } from '@/test-utils/engine';
import { stubTestEnv, TEST_ENV } from '@/test-utils/env';

const { state, revalidated } = vi.hoisted(() => ({ state: { db: null as unknown }, revalidated: [] as string[] }));

vi.mock('@/db/client', () => ({ getDb: async () => state.db }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));

const { POST, maxDuration } = await import('./route');

const HOST = 'reachout.example.com';
const context = {
  founder: { name: 'Jane Doe', bio: null, pastCompanies: null },
  company: { name: 'Acme', batch: null, website: null, oneLiner: null, description: null, teamSize: null, jobs: [] },
};
const drafts = { inviteNote: 'Hi Jane, coffee?', firstMessage: 'Hi Jane, the full pitch.' };

/** A Responses API answer holding `drafts`, as OpenAI sends it over raw HTTP. */
const openAiAnswer = () =>
  new Response(
    JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(drafts) }] }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

async function validSession(): Promise<string> {
  return createSessionToken(TEST_ENV.APP_PASSWORD, new Date());
}

function request(opts: { session?: string; origin?: string | null; host?: string; forwardedHost?: string } = {}): NextRequest {
  const headers: Record<string, string> = { host: opts.host ?? HOST };
  if (opts.forwardedHost !== undefined) headers['x-forwarded-host'] = opts.forwardedHost;
  if (opts.origin !== null) headers.origin = opts.origin ?? `https://${HOST}`;
  if (opts.session !== undefined) headers.cookie = `${SESSION_COOKIE}=${opts.session}`;
  return new NextRequest(`https://${HOST}/api/drafts/generate`, { method: 'POST', headers });
}

describe('POST /api/drafts/generate', () => {
  let db: Db;
  let fetchCalls: string[];

  beforeAll(stubTestEnv);

  beforeEach(async () => {
    db = await createTestDb();
    state.db = db;
    revalidated.length = 0;
    fetchCalls = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return openAiAnswer();
    });
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('OPENAI_MODEL', '');
    expect((await saveSettings(db, { ...DEFAULT_SETTINGS, aboutMe: 'Paris to San Francisco.' })).ok).toBe(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Keeps TEST_ENV: getEnv caches it for the whole file.
    vi.stubEnv('OPENAI_API_KEY', '');
  });

  it('allows one whole generation before the function is killed', () => {
    expect(GENERATION_DEADLINE_MS).toBeLessThan(maxDuration * 1000);
  });

  it('answers 401 without a valid session, and takes no lead', async () => {
    const lead = await seedLead(db, { draftStatus: 'pending', context });
    for (const session of [
      undefined,
      '',
      'garbage',
      `${Date.now() + 60_000}.forged`,
      await createSessionToken('another-password-x', new Date()),
    ]) {
      const response = await POST(request({ session }));
      expect(response.status, String(session)).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
    expect((await getLead(db, lead.id)).draftStatus).toBe('pending');
    expect(fetchCalls).toEqual([]);
  });

  it('answers 403 unless the Origin names this host, and takes no lead', async () => {
    const lead = await seedLead(db, { draftStatus: 'pending', context });
    const session = await validSession();
    const refused = [
      request({ session, origin: null }),
      request({ session, origin: 'null' }),
      request({ session, origin: 'not a url' }),
      request({ session, origin: 'https://evil.example.com' }),
      request({ session, origin: `https://${HOST}.evil.example.com` }),
      request({ session, origin: `https://${HOST}:8443` }),
      // Behind a proxy, the forwarded host is the one the browser saw.
      request({ session, host: 'internal:3000', forwardedHost: 'other.example.com' }),
    ];
    for (const req of refused) {
      const response = await POST(req);
      expect(response.status, req.headers.get('origin') ?? 'no origin').toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden' });
    }
    expect((await getLead(db, lead.id)).draftStatus).toBe('pending');
    expect(fetchCalls).toEqual([]);
  });

  it('writes one lead per call and answers as the action does', async () => {
    const lead = await seedLead(db, { draftStatus: 'pending', context });
    const session = await validSession();

    const response = await POST(request({ session, host: 'internal:3000', forwardedHost: HOST }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready',
      leadId: lead.id,
      error: null,
      counts: { none: 0, pending: 0, generating: 0, ready: 1, approved: 0, failed: 0 },
    });
    expect(fetchCalls).toEqual(['https://api.openai.com/v1/responses']);
    expect(revalidated).toEqual(['/']);
    expect(await getLead(db, lead.id)).toMatchObject({ draftStatus: 'ready', inviteNoteDraft: drafts.inviteNote });

    const last = await POST(request({ session }));
    expect(await last.json()).toMatchObject({ status: 'none_left', leadId: null, error: null });
    expect(revalidated).toEqual(['/']);
  });

  it('answers blocked without an OpenAI key, before taking any lead', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const lead = await seedLead(db, { draftStatus: 'pending', context });
    const response = await POST(request({ session: await validSession() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'blocked', leadId: null, error: 'missing_api_key' });
    expect((await getLead(db, lead.id)).draftStatus).toBe('pending');
    expect(fetchCalls).toEqual([]);
  });
});
