import { describe, expect, it } from 'vitest';
import { createFakeUnipile, makeProfile } from '@/test-utils/fake-unipile';
import { createDryRunClient } from './dry-run';

describe('createDryRunClient', () => {
  it('never calls write endpoints and returns dry_ ids', async () => {
    const real = createFakeUnipile();
    const dry = createDryRunClient(real);
    expect((await dry.sendInvitation('ACo1', 'x')).invitationId).toMatch(/^dry_/);
    expect((await dry.startChat('ACo1', 'x')).chatId).toMatch(/^dry_/);
    expect((await dry.sendMessage('chat_1', 'x')).messageId).toMatch(/^dry_/);
    await dry.cancelInvitation('inv_1');
    expect(real.calls).toEqual([]);
  });

  it('passes reads through, except chats that only exist in the dry run', async () => {
    const real = createFakeUnipile();
    real.profiles.set('jane', makeProfile());
    const dry = createDryRunClient(real);
    expect(await dry.getProfile('jane')).toEqual(makeProfile());
    expect(await dry.listChatMessages('dry_chat_1', 20)).toEqual([]);
    expect(await dry.listSentInvitations()).toEqual([]);
    expect(real.calls.map((c) => c.method)).toEqual(['getProfile', 'listSentInvitations']);
  });

  it('looks a chat up and reads a real chat as the live client does', async () => {
    const real = createFakeUnipile();
    const since = new Date('2026-11-10T09:00:00Z');
    const note = { id: 'm1', isSender: true, timestamp: '2026-11-10T09:00:05.000Z', text: 'Hi Jane' };
    real.chatByAttendee.set('ACoJane', 'chat_1');
    real.chatMessages.set('chat_1', [note]);
    const dry = createDryRunClient(real);
    expect(await dry.findChatWithAttendee('ACoJane')).toBe('chat_1');
    expect(await dry.findChatWithAttendee('ACoBob')).toBeNull();
    expect(await dry.listChatMessages('chat_1', 50, since)).toEqual([note]);
    expect(real.calls).toEqual([
      { method: 'findChatWithAttendee', args: ['ACoJane'] },
      { method: 'findChatWithAttendee', args: ['ACoBob'] },
      { method: 'listChatMessages', args: ['chat_1', 50, since] },
    ]);
  });
});
