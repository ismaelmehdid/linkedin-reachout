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
});
