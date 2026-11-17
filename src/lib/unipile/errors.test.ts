import { describe, expect, it } from 'vitest';
import { classifyUnipileError, UnipileError } from './errors';

describe('classifyUnipileError', () => {
  it.each([
    [429, 'errors/too_many_requests', 'limit'],
    [422, 'errors/cannot_resend_yet', 'limit'],
    [422, 'errors/limit_exceeded', 'limit'],
    [503, null, 'transient'],
    [0, 'network_error', 'transient'],
    [422, 'errors/already_connected', 'already_connected'],
    [422, 'errors/already_invited_recently', 'already_invited'],
    [422, 'errors/cannot_invite_attendee', 'permanent'],
    [404, 'errors/invalid_resource_identifier', 'permanent'],
    [422, 'errors/no_connection_with_recipient', 'permanent'],
    [422, 'errors/brand_new_error', 'unknown'],
    // Unipile refused the account itself, not one lead.
    [401, 'errors/disconnected_account', 'account'],
    [401, null, 'account'],
    [403, 'errors/feature_not_subscribed', 'account'],
    [422, 'errors/expired_credentials', 'account'],
    [402, 'errors/subscription_required', 'account'],
    [400, 'errors/invalid_api_key', 'account'],
    [422, 'errors/insufficient_permissions', 'account'],
    // A 404 that names the account is not a missing profile.
    [404, 'errors/account_not_found', 'account'],
    // The classes checked earlier keep their meaning.
    [429, 'errors/account_rate_limited', 'limit'],
    [503, 'errors/account_unavailable', 'transient'],
    [403, 'errors/limit_exceeded', 'limit'],
  ] as const)('classifies HTTP %i with type %s as %s', (status, type, expected) =>
    expect(classifyUnipileError(new UnipileError(status, type, ''))).toBe(expected));

  it('classifies an error that is not from Unipile as unknown', () => expect(classifyUnipileError(new TypeError('bug'))).toBe('unknown'));

  it('defaults retryAfterSeconds to null', () => {
    expect(new UnipileError(500, null, 'x').retryAfterSeconds).toBeNull();
  });
});
