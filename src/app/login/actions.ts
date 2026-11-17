'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSessionToken, safeEqual, SESSION_COOKIE, SESSION_TTL_MS } from '@/lib/auth/session';
import { getEnv } from '@/lib/env';

/** Slows down password guessing. */
const WRONG_PASSWORD_DELAY_MS = 1_000;

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const { appPassword } = getEnv();
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
