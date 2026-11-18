import { revalidatePath } from 'next/cache';
import type { NextRequest } from 'next/server';
import { generateNextDraft, wroteToLead } from '@/app/drafts/generate-next';
import { getDb } from '@/db/client';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';
import { getEnv, type Env } from '@/lib/env';

/**
 * Writes the drafts of one lead, as generateNextDraftAction does. The dashboard calls this route rather
 * than the action because the browser dispatches server actions one at a time, and a route lets its
 * workers run in parallel. One generation must fit (its deadline is GENERATION_DEADLINE_MS); a test checks it.
 */
export const maxDuration = 120;

/**
 * The request filter already answers 401 here without a session; the route checks again, as the actions
 * do, so that a matcher change cannot open it.
 */
async function hasSession(request: NextRequest, appPassword: string): Promise<boolean> {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, appPassword, new Date());
}

/**
 * The check Next makes on a server action: the browser's `Origin` must name the host the request was sent
 * to (`x-forwarded-host` behind a proxy, else `host`). The session cookie is SameSite=Lax, which already
 * keeps it off cross-site POSTs; this is defence in depth.
 */
function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || request.headers.get('host');
  return originHost !== '' && host !== null && originHost === host;
}

export async function POST(request: NextRequest): Promise<Response> {
  let env: Env;
  try {
    env = getEnv();
  } catch (error) {
    // The names go to the logs only, as on the tick route.
    console.error('drafts: misconfigured environment', error instanceof Error ? error.message : error);
    return Response.json({ error: 'misconfigured' }, { status: 500 });
  }
  if (!(await hasSession(request, env.appPassword))) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!isSameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403 });

  const result = await generateNextDraft(await getDb());
  if (wroteToLead(result)) revalidatePath('/');
  return Response.json(result);
}
