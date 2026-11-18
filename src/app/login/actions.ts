'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSessionToken, safeEqual, SESSION_COOKIE, SESSION_TTL_MS } from '@/lib/auth/session';
import { getEnv } from '@/lib/env';

/** Slows down password guessing. */
const WRONG_PASSWORD_DELAY_MS = 1_000;

/** Shown when the environment is invalid. It names no variable: the names go to the function log only. */
const MISCONFIGURED_MESSAGE =
  'The server is not configured correctly. An environment variable is missing or invalid: the function log names it.';

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  let appPassword: string;
  try {
    ({ appPassword } = getEnv());
  } catch (error) {
    // Left to throw, this answers the form with a server error page that says nothing. First deployments
    // hit exactly this, so the form says where to look and the log says what is wrong.
    console.error('login: misconfigured environment', error instanceof Error ? error.message : error);
    return { error: MISCONFIGURED_MESSAGE };
  }
  const password = formData.get('password');
  if (typeof password !== 'string' || !safeEqual(password, appPassword)) {
    await new Promise((resolve) => setTimeout(resolve, WRONG_PASSWORD_DELAY_MS));
    return { error: 'Wrong password' };
  }

  // The password is the signing secret, so changing it logs every session out.
  (await cookies()).set(SESSION_COOKIE, await createSessionToken(appPassword, new Date()), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
  redirect('/');
}
