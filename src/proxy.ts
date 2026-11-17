import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath, SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';
import { APP_PASSWORD_MIN_LENGTH } from '@/lib/env';

/**
 * The secret that signs sessions, read as `parseEnv` reads it: trimmed, and empty when the password is
 * unset or under the minimum length. An empty secret verifies no session, so nobody gets through.
 */
function sessionSecret(): string {
  const password = process.env.APP_PASSWORD?.trim() ?? '';
  return password.length >= APP_PASSWORD_MIN_LENGTH ? password : '';
}

/**
 * Requires a valid session cookie on every page and API route but the public paths, which check their own
 * secret. The password is the signing secret, so changing APP_PASSWORD logs every session out.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token, sessionSecret(), new Date())) return NextResponse.next();

  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
