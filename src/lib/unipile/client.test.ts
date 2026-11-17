import { beforeEach, describe, expect, it } from 'vitest';
import { createUnipileClient } from './client';
import type { UnipileClient } from './types';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createUnipileClient', () => {
  let captured: Request[];
  let responses: Response[];
  let client: UnipileClient;

  beforeEach(() => {
    captured = [];
    responses = [];
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(new Request(input, init));
      return responses.shift()!;
    };
    client = createUnipileClient({
      dsn: 'api1.unipile.com:13111',
      apiKey: 'key_1',
      accountId: 'acc_1',
      fetch: fetchStub as typeof fetch,
    });
  });

  it('fetches a profile with its experience and maps it', async () => {
    responses.push(
      json(200, {
        provider_id: 'ACoJane',
        public_identifier: 'jane-doe',
        first_name: 'Jane',
        last_name: 'Doe',
        headline: 'CTO',
        location: 'Paris',
        network_distance: 'SECOND_DEGREE',
        work_experience: [
          { company: 'Old Co', position: 'Dev', end: '2020' },
          { company: 'Acme', position: 'CTO', current: true },
        ],
      }),
    );
    expect(await client.getProfile('jane-doe')).toEqual({
      providerId: 'ACoJane',
      publicIdentifier: 'jane-doe',
      firstName: 'Jane',
      lastName: 'Doe',
      headline: 'CTO',
      location: 'Paris',
      networkDistance: 'SECOND_DEGREE',
      currentCompany: 'Acme',
      currentPosition: 'CTO',
    });
    expect(captured[0].url).toBe(
      'https://api1.unipile.com:13111/api/v1/users/jane-doe?account_id=acc_1&linkedin_sections=experience_preview',
    );
    expect(captured[0].headers.get('x-api-key')).toBe('key_1');
    expect(captured[0].headers.get('accept')).toBe('application/json');
  });

  it('falls back to the first experience without an end, then to null', async () => {
    responses.push(
      json(200, {
        provider_id: 'ACo1',
        network_distance: 'WEIRD',
        work_experience: [
          { company: 'Old Co', position: 'Dev', end: '2020' },
          { company: 'Open Co', position: 'Lead' },
        ],
      }),
      json(200, { provider_id: 'ACo2', work_experience: [{ company: 'Old', position: 'Dev', end: '2019' }] }),
    );
    expect(await client.getProfile('a')).toMatchObject({
      networkDistance: null,
      currentCompany: 'Open Co',
      currentPosition: 'Lead',
      firstName: null,
      publicIdentifier: null,
    });
    expect(await client.getProfile('b')).toMatchObject({ currentCompany: null, currentPosition: null });
  });

  it('rejects a profile without provider_id', async () => {
    responses.push(json(200, { first_name: 'Jane' }));
    await expect(client.getProfile('x')).rejects.toMatchObject({
      status: 422,
      type: 'errors/invalid_response',
    });
  });

  it('sends an invitation as JSON', async () => {
    responses.push(json(201, { object: 'UserInvitationSent', invitation_id: 'inv_1' }));
    expect(await client.sendInvitation('ACoJane', 'Hi Jane')).toEqual({ invitationId: 'inv_1' });
    expect(captured[0].method).toBe('POST');
    expect(captured[0].url).toBe('https://api1.unipile.com:13111/api/v1/users/invite');
    expect(await captured[0].json()).toEqual({ provider_id: 'ACoJane', account_id: 'acc_1', message: 'Hi Jane' });
  });

  it('starts a chat with multipart form data', async () => {
    responses.push(json(201, { object: 'ChatStarted', chat_id: 'chat_1', message_id: 'msg_1' }));
    expect(await client.startChat('ACoJane', 'Hello')).toEqual({ chatId: 'chat_1', messageId: 'msg_1' });
    const form = await captured[0].formData();
    expect([form.get('account_id'), form.get('attendees_ids'), form.get('text')]).toEqual([
      'acc_1',
      'ACoJane',
      'Hello',
    ]);
  });

  it('sends a message to an existing chat', async () => {
    responses.push(json(201, { object: 'MessageSent', message_id: 'msg_2' }));
    expect(await client.sendMessage('chat 1', 'Yo')).toEqual({ messageId: 'msg_2' });
    expect(captured[0].url).toBe('https://api1.unipile.com:13111/api/v1/chats/chat%201/messages');
    expect((await captured[0].formData()).get('text')).toBe('Yo');
  });

  // A 2xx on a write endpoint means Unipile accepted it, whatever the body holds: it must never throw.
  it.each([
    ['an id that is null', () => json(201, { object: 'MessageSent', message_id: null })],
    ['an empty id', () => json(201, { object: 'MessageSent', message_id: '' })],
    ['no id', () => json(201, { object: 'MessageSent' })],
    ['a body that is not JSON', () => new Response('OK', { status: 201 })],
    ['a JSON body that is not an object', () => json(200, null)],
    ['no body', () => new Response(null, { status: 204 })],
  ])('reports a message as sent when the 2xx answer has %s', async (_label, answer) => {
    responses.push(answer());
    expect(await client.sendMessage('chat_1', 'Yo')).toEqual({ messageId: null });
  });

  it('reports a chat as started when the 2xx answer has no chat id or no message id', async () => {
    responses.push(
      json(201, { object: 'ChatStarted', chat_id: null, message_id: null }),
      json(201, { object: 'ChatStarted', chat_id: 'chat_1' }),
      new Response('<html>ok</html>', { status: 200 }),
    );
    expect(await client.startChat('ACoJane', 'Hello')).toEqual({ chatId: null, messageId: null });
    expect(await client.startChat('ACoJane', 'Hello')).toEqual({ chatId: 'chat_1', messageId: null });
    expect(await client.startChat('ACoJane', 'Hello')).toEqual({ chatId: null, messageId: null });
  });

  it('reports an invitation as sent when the 2xx answer has no invitation id', async () => {
    responses.push(json(201, { object: 'UserInvitationSent' }), new Response('OK', { status: 201 }));
    expect(await client.sendInvitation('ACoJane', 'Hi Jane')).toEqual({ invitationId: null });
    expect(await client.sendInvitation('ACoJane', 'Hi Jane')).toEqual({ invitationId: null });
  });

  it('still raises a write that Unipile refused', async () => {
    responses.push(json(422, { type: 'errors/invalid_recipient' }));
    await expect(client.sendMessage('chat_1', 'Yo')).rejects.toMatchObject({ status: 422, type: 'errors/invalid_recipient' });
  });

  it('finds the chat with a person by provider id', async () => {
    responses.push(
      json(200, { object: 'ChatList', items: [{ object: 'Chat', id: 'chat_1', name: null }, { object: 'Chat', id: 'chat_2' }], cursor: null }),
    );
    expect(await client.findChatWithAttendee('ACo Jane')).toBe('chat_1');
    expect(captured[0].method).toBe('GET');
    expect(captured[0].url).toBe('https://api1.unipile.com:13111/api/v1/chat_attendees/ACo%20Jane/chats?account_id=acc_1');
  });

  it('finds no chat when the list is empty or Unipile does not know the person', async () => {
    responses.push(
      json(200, { object: 'ChatList', items: [], cursor: null }),
      json(200, { object: 'ChatList' }),
      json(404, { type: 'errors/resource_not_found', title: 'Attendee not found' }),
    );
    expect(await client.findChatWithAttendee('ACoJane')).toBeNull();
    expect(await client.findChatWithAttendee('ACoJane')).toBeNull();
    expect(await client.findChatWithAttendee('ACoJane')).toBeNull();
  });

  it('raises every other failure of the chat lookup', async () => {
    responses.push(json(401, { type: 'errors/disconnected_account' }), json(200, { items: [{ object: 'Chat' }] }));
    await expect(client.findChatWithAttendee('ACoJane')).rejects.toMatchObject({ status: 401, type: 'errors/disconnected_account' });
    await expect(client.findChatWithAttendee('ACoJane')).rejects.toMatchObject({ status: 422, type: 'errors/invalid_response' });
  });

  it('follows cursors when listing sent invitations', async () => {
    responses.push(
      json(200, { items: [{ id: 'i1', invited_user_id: 'ACo1', invited_user_public_id: 'one' }], cursor: 'c2' }),
      json(200, { items: [{ id: 'i2', invited_user_id: 'ACo2', invited_user_public_id: 'two' }], cursor: null }),
    );
    expect((await client.listSentInvitations()).map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(captured[0].url).toBe(
      'https://api1.unipile.com:13111/api/v1/users/invite/sent?account_id=acc_1&limit=100',
    );
    expect(captured[1].url).toContain('cursor=c2');
  });

  it('stops listing sent invitations after 20 pages', async () => {
    for (let i = 0; i < 25; i++) responses.push(json(200, { items: [{ id: `i${i}` }], cursor: 'more' }));
    expect(await client.listSentInvitations()).toHaveLength(20);
    expect(captured).toHaveLength(20);
  });

  it('cancels an invitation with DELETE', async () => {
    responses.push(json(200, { object: 'UserInvitationCancelled' }));
    await client.cancelInvitation('inv_1');
    expect(captured[0].method).toBe('DELETE');
    expect(captured[0].url).toBe('https://api1.unipile.com:13111/api/v1/users/invite/sent/inv_1?account_id=acc_1');
  });

  it('lists chat messages and maps is_sender', async () => {
    responses.push(
      json(200, {
        items: [
          { id: 'm1', is_sender: 1, timestamp: '2026-11-17T09:00:00Z', text: 'hi' },
          { id: 'm2', is_sender: 0, timestamp: '2026-11-17T09:01:00Z', text: null },
          { id: 'm3', is_sender: true, timestamp: '2026-11-17T09:02:00Z' },
        ],
      }),
    );
    expect(await client.listChatMessages('chat_1', 20)).toEqual([
      { id: 'm1', isSender: true, timestamp: '2026-11-17T09:00:00Z', text: 'hi' },
      { id: 'm2', isSender: false, timestamp: '2026-11-17T09:01:00Z', text: null },
      { id: 'm3', isSender: true, timestamp: '2026-11-17T09:02:00Z', text: null },
    ]);
    expect(captured[0].url).toBe('https://api1.unipile.com:13111/api/v1/chats/chat_1/messages?limit=20');
  });

  it('asks only for the chat messages after a given time', async () => {
    responses.push(json(200, { object: 'MessageList', items: [], cursor: null }));
    expect(await client.listChatMessages('chat_1', 50, new Date('2026-11-10T09:00:00Z'))).toEqual([]);
    expect(captured[0].url).toBe(
      'https://api1.unipile.com:13111/api/v1/chats/chat_1/messages?limit=50&after=2026-11-10T09%3A00%3A00.000Z',
    );
  });

  it('raises UnipileError with type and retry_after', async () => {
    responses.push(json(429, { status: 429, type: 'errors/too_many_requests', retry_after: 120 }));
    await expect(client.getProfile('x')).rejects.toMatchObject({
      status: 429,
      type: 'errors/too_many_requests',
      retryAfterSeconds: 120,
    });
  });

  it('reads the Retry-After header and tolerates non-JSON bodies', async () => {
    responses.push(new Response('oops', { status: 503, statusText: 'Unavailable', headers: { 'retry-after': '30' } }));
    await expect(client.getProfile('x')).rejects.toMatchObject({
      status: 503,
      type: null,
      retryAfterSeconds: 30,
      message: 'Unavailable',
    });
  });

  it('uses detail then title as the error message', async () => {
    responses.push(json(422, { type: 'errors/x', title: 'Title', detail: 'Detail' }));
    await expect(client.getProfile('x')).rejects.toMatchObject({ message: 'Detail' });
  });

  it('turns network failures into status 0', async () => {
    client = createUnipileClient({
      dsn: 'https://x',
      apiKey: 'k',
      accountId: 'a',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(client.getProfile('x')).rejects.toMatchObject({ status: 0, type: 'network_error' });
  });

  it('turns a timeout into status 0', async () => {
    client = createUnipileClient({
      dsn: 'https://x/',
      apiKey: 'k',
      accountId: 'a',
      timeoutMs: 10,
      fetch: ((_: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })) as typeof fetch,
    });
    await expect(client.getProfile('x')).rejects.toMatchObject({ status: 0, type: 'network_error' });
  });
});
