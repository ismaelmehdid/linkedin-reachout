import { after } from 'next/server';
import { getDb } from '@/db/client';
import { isAuthorizedBearer } from '@/lib/auth/session';
import { createEngineDeps } from '@/lib/deps';
import { pingDatabase } from '@/lib/engine/state';
import { runTick } from '@/lib/engine/tick';
import { getEnv, type Env } from '@/lib/env';

/**
 * Seconds before the platform kills this function (Vercel Hobby with Fluid compute allows up to 300).
 * It must stay below TICK_LEASE_MS (240 000 ms), so that a tick is killed before its lease can expire and
 * another tick can start, and above the engine's time budget for one tick (ACTION_START_BUDGET_MS plus
 * the slowest action). A test checks both.
 */
export const maxDuration = 180;

export async function GET(request: Request): Promise<Response> {
  let env: Env;
  try {
    env = getEnv();
  } catch (error) {
    // The names go to the logs only; the caller learns nothing about the configuration.
    console.error('tick: misconfigured environment', error instanceof Error ? error.message : error);
    return Response.json({ error: 'misconfigured' }, { status: 500 });
  }
  if (!isAuthorizedBearer(request.headers.get('authorization'), env.cronSecret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  // The tick runs after the answer, so without this read a database that is down, suspended or not
  // migrated would still answer 202. With it, the scheduler sees the failure and can report it.
  try {
    await pingDatabase(await getDb());
  } catch (error) {
    console.error('tick: database unreachable', error);
    return Response.json({ error: 'database_unreachable' }, { status: 500 });
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
