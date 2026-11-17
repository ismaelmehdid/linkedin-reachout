import { describe, expect, it } from 'vitest';
import { classifyUnipileError, UnipileError } from './errors';

describe('classifyUnipileError', () => {
  it.each([
    [new UnipileError(429, 'errors/too_many_requests', ''), 'limit'],
    [new UnipileError(422, 'errors/cannot_resend_yet', ''), 'limit'],
    [new UnipileError(422, 'errors/limit_exceeded', ''), 'limit'],
    [new UnipileError(503, null, ''), 'transient'],
    [new UnipileError(0, 'network_error', ''), 'transient'],
    [new UnipileError(422, 'errors/already_connected', ''), 'already_connected'],
    [new UnipileError(422, 'errors/already_invited_recently', ''), 'already_invited'],
    [new UnipileError(422, 'errors/cannot_invite_attendee', ''), 'permanent'],
    [new UnipileError(404, 'errors/invalid_resource_identifier', ''), 'permanent'],
    [new UnipileError(422, 'errors/no_connection_with_recipient', ''), 'permanent'],
    [new UnipileError(422, 'errors/brand_new_error', ''), 'unknown'],
    [new TypeError('bug'), 'unknown'],
  ])('classifies %o as %s', (err, expected) => expect(classifyUnipileError(err)).toBe(expected));

  it('defaults retryAfterSeconds to null', () => {
    expect(new UnipileError(500, null, 'x').retryAfterSeconds).toBeNull();
  });
});
