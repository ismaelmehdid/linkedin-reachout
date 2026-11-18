import { describe, expect, it } from 'vitest';
import { canEditFirstMessage, canEditInviteNote, canRegenerate, hasDrafts, notePreview, noteTooLong } from './draft-review';

describe('draft review rules', () => {
  it('lets the note change only while the lead is queued', () => {
    expect(canEditInviteNote('queued')).toBe(true);
    for (const status of ['invite_sent', 'already_connected', 'messaged', 'failed'])
      expect(canEditInviteNote(status)).toBe(false);
  });

  it('lets the first message change until it is sent', () => {
    for (const status of ['queued', 'invite_sent', 'accepted', 'already_connected'])
      expect(canEditFirstMessage(status)).toBe(true);
    for (const status of ['messaged', 'followup_1', 'replied', 'failed', 'no_response'])
      expect(canEditFirstMessage(status)).toBe(false);
  });

  it('regenerates a ready, approved or failed draft of a queued lead only', () => {
    expect(canRegenerate({ status: 'queued', draftStatus: 'ready' })).toBe(true);
    expect(canRegenerate({ status: 'queued', draftStatus: 'approved' })).toBe(true);
    expect(canRegenerate({ status: 'queued', draftStatus: 'failed' })).toBe(true);
    expect(canRegenerate({ status: 'queued', draftStatus: 'pending' })).toBe(false);
    expect(canRegenerate({ status: 'queued', draftStatus: 'none' })).toBe(false);
    expect(canRegenerate({ status: 'invite_sent', draftStatus: 'approved' })).toBe(false);
  });

  it('opens a review only for a lead with written drafts', () => {
    expect(hasDrafts({ draftStatus: 'ready', inviteNoteDraft: 'n', firstMessageDraft: 'm' })).toBe(true);
    expect(hasDrafts({ draftStatus: 'failed', inviteNoteDraft: null, firstMessageDraft: null })).toBe(false);
    expect(hasDrafts({ draftStatus: 'none', inviteNoteDraft: 'n', firstMessageDraft: 'm' })).toBe(false);
  });

  it('counts the note as it is saved, trimmed, against the 300 limit', () => {
    expect(noteTooLong(`  ${'a'.repeat(300)}  `)).toBe(false);
    expect(noteTooLong('a'.repeat(301))).toBe(true);
  });

  it('previews the first words of a note', () => {
    expect(notePreview('Hi Jane, short note.')).toBe('Hi Jane, short note.');
    const preview = notePreview(`Hi Jane, ${'word '.repeat(30)}`);
    expect(preview.length).toBeLessThanOrEqual(61);
    expect(preview.endsWith('…')).toBe(true);
  });
});
