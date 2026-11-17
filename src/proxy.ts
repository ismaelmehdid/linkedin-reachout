import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath, SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session';

/**
 * Requires a valid session cookie on every page and API route but the public paths, which check their own
 * secret. The password is the signing secret, so changing APP_PASSWORD logs every session out.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token, process.env.APP_PASSWORD ?? '', new Date())) return NextResponse.next();

  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
