export class UnipileError extends Error {
  constructor(
    public status: number,
    public type: string | null,
    message: string,
    public retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'UnipileError';
  }
}

export type ErrorClass =
  | 'limit'
  | 'transient'
  | 'already_connected'
  | 'already_invited'
  | 'permanent'
  | 'unknown';

const LIMIT_TYPES = new Set([
  'errors/cannot_resend_yet',
  'errors/limit_exceeded',
  'errors/too_many_requests',
  'errors/connection_limit_reached',
]);

const PERMANENT_TYPES = new Set([
  'errors/cannot_invite_attendee',
  'errors/invalid_recipient',
  'errors/blocked_recipient',
  'errors/user_unreachable',
  'errors/invalid_resource_identifier',
  'errors/no_connection_with_recipient',
  'errors/too_many_characters',
]);

export function classifyUnipileError(err: unknown): ErrorClass {
  if (!(err instanceof UnipileError)) return 'unknown';
  const { status, type } = err;
  if (status === 429 || (type !== null && LIMIT_TYPES.has(type))) return 'limit';
  if (status === 0 || status >= 500) return 'transient';
  if (type === 'errors/already_connected') return 'already_connected';
  if (type === 'errors/already_invited_recently') return 'already_invited';
  if (status === 404 || (type !== null && PERMANENT_TYPES.has(type))) return 'permanent';
  return 'unknown';
}
