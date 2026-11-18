import { describe, expect, it } from 'vitest';
import type { LeadStatus } from '@/db/schema';
import { DEFAULT_SETTINGS } from '@/lib/settings/settings';
import { NOW } from '@/test-utils/engine';
import { MESSAGE_STEP_BY_STATUS, firstMessageDueAt, nextDueAfterSend, nextStep, statusAfterMessage } from './steps';

describe('steps', () => {
  it('maps each status to its next step', () => {
    expect(['queued', 'invite_sent', 'accepted', 'already_connected', 'messaged', 'followup_1', 'followup_2'].map((s) => nextStep(s as LeadStatus)))
      .toEqual(['invite', 'expire_invite', 'first_message', 'first_message', 'followup_1', 'followup_2', 'finish']);
    for (const s of ['replied', 'no_response', 'invite_expired', 'failed'] as const) expect(nextStep(s)).toBeNull();
  });

  it('maps each message status to its step and each step to the status it leaves', () => {
    for (const [status, step] of Object.entries(MESSAGE_STEP_BY_STATUS)) expect(nextStep(status as LeadStatus)).toBe(step);
    expect((['first_message', 'followup_1', 'followup_2'] as const).map(statusAfterMessage)).toEqual(['messaged', 'followup_1', 'followup_2']);
  });

  it('schedules the next step 2, 3 and 3 calendar days after a send', () => {
    expect(nextDueAfterSend('messaged', NOW, DEFAULT_SETTINGS)).toEqual(new Date('2026-11-19T09:00:00Z'));
    expect(nextDueAfterSend('followup_1', NOW, DEFAULT_SETTINGS)).toEqual(new Date('2026-11-20T09:00:00Z'));
    expect(nextDueAfterSend('followup_2', NOW, DEFAULT_SETTINGS)).toEqual(new Date('2026-11-20T09:00:00Z'));
  });

  it('keeps the local time across a time change', () =>
    expect(nextDueAfterSend('messaged', new Date('2027-03-27T09:00:00Z'), DEFAULT_SETTINGS)).toEqual(new Date('2027-03-29T08:00:00Z')));

  it('schedules the first message 60 to 180 minutes after acceptance', () => {
    expect(firstMessageDueAt(NOW, () => 0, DEFAULT_SETTINGS.delays)).toEqual(new Date('2026-11-17T10:00:00Z'));
    expect(firstMessageDueAt(NOW, () => 0.5, DEFAULT_SETTINGS.delays)).toEqual(new Date('2026-11-17T11:00:00Z'));
  });

  it('adds a random part of the follow-up jitter to a follow-up, and none to the end of the sequence', () => {
    const s = { ...DEFAULT_SETTINGS, pacing: { ...DEFAULT_SETTINGS.pacing, followupJitterMinutes: 180 } };
    expect(nextDueAfterSend('messaged', NOW, s, () => 0.5)).toEqual(new Date('2026-11-19T10:30:00Z'));
    expect(nextDueAfterSend('followup_2', NOW, s, () => 0.5)).toEqual(new Date('2026-11-20T09:00:00Z'));
    expect(nextDueAfterSend('messaged', NOW, s)).toEqual(new Date('2026-11-19T09:00:00Z'));
  });
});
