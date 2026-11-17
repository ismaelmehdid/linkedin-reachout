import { after } from 'next/server';
import { isAuthorizedBearer } from '@/lib/auth/session';
import { createEngineDeps } from '@/lib/deps';
import { runTick } from '@/lib/engine/tick';
import { getEnv } from '@/lib/env';

/**
 * Seconds before the platform kills this function (Vercel Hobby with Fluid compute allows up to 300).
 * It must stay below TICK_LEASE_MS (240 000 ms): `releaseTickLock` is unconditional, so a tick has to be
 * killed before its lease can expire and another tick can take the lock.
 */
export const maxDuration = 180;

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedBearer(request.headers.get('authorization'), getEnv().cronSecret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  after(async () => {
    try {
      console.log('tick', JSON.stringify(await runTick(await createEngineDeps())));
    } catch (error) {
      console.error('tick failed', error);
    }
  });
  return Response.json({ accepted: true }, { status: 202 });
}
