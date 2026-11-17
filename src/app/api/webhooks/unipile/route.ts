import { getDb } from '@/db/client';
import { safeEqual } from '@/lib/auth/session';
import { getEnv, type Env } from '@/lib/env';
import { processWebhook } from '@/lib/webhooks/handle';

/** Unipile v1 webhooks are not signed: the `Unipile-Auth` header is the only check. */
export async function POST(request: Request): Promise<Response> {
  let env: Env;
  try {
    env = getEnv();
  } catch (error) {
    // The names go to the logs only; the caller learns nothing about the configuration.
    console.error('webhook: misconfigured environment', error instanceof Error ? error.message : error);
    return Response.json({ error: 'misconfigured' }, { status: 500 });
  }
  const secret = request.headers.get('unipile-auth');
  if (secret === null || !safeEqual(secret, env.webhookSecret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    const { outcome } = await processWebhook(await getDb(), body, {
      accountId: env.unipileAccountId,
      now: new Date(),
      random: Math.random,
    });
    return Response.json({ outcome });
  } catch (error) {
    // A 500 makes Unipile retry the call.
    console.error('webhook failed', error);
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
