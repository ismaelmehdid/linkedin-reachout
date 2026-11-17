/**
 * The dashboard session and the request checks. Web Crypto only, no Node APIs, so the request filter can
 * import this module in any runtime.
 */

export const SESSION_COOKIE = 'reachout_session';

/** 30 days. */
export const SESSION_TTL_MS = 2_592_000_000;

/** The only paths reachable without a session. Each one checks its own secret instead. */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/login', '/api/tick', '/api/webhooks/unipile']);

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url HMAC-SHA256 of `payload`. An empty secret would sign with an empty key, so it throws instead. */
async function sign(secret: string, payload: string): Promise<string> {
  if (secret === '') throw new Error('The session secret must not be empty');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
}

/** Compares two strings in time that depends on their lengths only, never on where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** `<expiresAtMs>.<base64url HMAC-SHA256(secret, expiresAtMs)>`, valid for SESSION_TTL_MS from `now`. */
export async function createSessionToken(secret: string, now: Date): Promise<string> {
  const expiresAtMs = String(now.getTime() + SESSION_TTL_MS);
  return `${expiresAtMs}.${await sign(secret, expiresAtMs)}`;
}

/** True only for a well-formed token signed with `secret` whose expiry is after `now`. */
export async function verifySessionToken(token: string | undefined, secret: string, now: Date): Promise<boolean> {
  if (!token || secret === '') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expiresAt, signature] = parts;
  if (!/^\d+$/.test(expiresAt)) return false;
  const expiresAtMs = Number(expiresAt);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now.getTime()) return false;
  return safeEqual(signature, await sign(secret, expiresAt));
}

/** True only for exactly `Bearer <secret>`, with a non-empty secret. */
export function isAuthorizedBearer(header: string | null, secret: string): boolean {
  return header !== null && secret !== '' && safeEqual(header, `Bearer ${secret}`);
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}
