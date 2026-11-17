import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getEnv } from '@/lib/env';
import { SESSION_COOKIE, verifySessionToken } from './session';

/**
 * Call first in every server action. The request filter is not enough: an action runs as a POST to the
 * page that invokes it, so a matcher change or a public page can skip the filter.
 */
export async function requireSession(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token, getEnv().appPassword, new Date()))) redirect('/login');
}
