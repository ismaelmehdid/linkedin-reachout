import { describe, expect, it } from 'vitest';
import type { Lead } from '@/db/schema';
import { NOW } from '@/test-utils/engine';
import {
  dashboardBanners,
  describeNextAction,
  formatImportSummary,
  formatLocal,
  leadDisplayName,
  leadRoleLine,
} from './display';

const D = new Date('2026-11-19T09:00:00Z');
const make = (patch: Partial<Lead>) =>
  ({ status: 'queued', paused: false, nextActionAt: null, firstName: null, lastName: null, slug: 'jane-doe', ...patch }) as Lead;

describe('lead display', () => {
  it('describes the next action and its due time', () => {
    expect(describeNextAction(make({ status: 'messaged', nextActionAt: D }))).toEqual({ label: 'Follow-up 1', dueAt: D });
    expect(describeNextAction(make({ status: 'queued', paused: true, nextActionAt: D }))).toEqual({ label: 'Paused · Invite', dueAt: D });
    expect(describeNextAction(make({ status: 'replied' }))).toBeNull();
  });

  it('labels the next action of every status, and none for final statuses', () => {
    const label = (status: Lead['status']) => describeNextAction(make({ status }))?.label ?? null;
    expect(
      (['queued', 'invite_sent', 'accepted', 'already_connected', 'messaged', 'followup_1', 'followup_2'] as const).map(label),
    ).toEqual(['Invite', 'Withdraw invite', 'First message', 'First message', 'Follow-up 1', 'Follow-up 2', 'Mark no response']);
    expect((['replied', 'no_response', 'invite_expired', 'failed'] as const).map(label)).toEqual([null, null, null, null]);
    expect(describeNextAction(make({ status: 'failed', paused: true }))).toBeNull();
  });

  it('names a lead by name or slug and formats local dates', () => {
    expect(leadDisplayName(make({ firstName: 'Jane', lastName: 'Doe' }))).toBe('Jane Doe');
    expect(leadDisplayName(make({ firstName: 'Jane' }))).toBe('Jane');
    expect(leadDisplayName(make({}))).toBe('jane-doe');
    expect(formatLocal(new Date('2026-11-17T07:30:00Z'), 'Europe/Paris')).toBe('2026-11-17 08:30');
  });

  it('describes the current role from position and company', () => {
    expect(leadRoleLine({ position: 'CTO', company: 'Acme' })).toBe('CTO at Acme');
    expect(leadRoleLine({ position: null, company: 'Acme' })).toBe('Acme');
    expect(leadRoleLine({ position: 'CTO', company: null })).toBe('CTO');
    expect(leadRoleLine({ position: null, company: '  ' })).toBeNull();
    expect(leadRoleLine({ position: ' CTO ', company: '' })).toBe('CTO');
    expect(leadRoleLine({ position: null, company: null })).toBeNull();
  });

  it('summarizes an import', () => {
    expect(
      formatImportSummary({
        added: 2,
        duplicates: ['jane-doe'],
        invalid: [{ line: 'linkedin.com/company/acme', error: 'Not a profile URL' }],
      }),
    ).toBe('2 added · 1 already contacted: jane-doe · 1 invalid: linkedin.com/company/acme (Not a profile URL)');
    expect(
      formatImportSummary({
        added: 0,
        duplicates: ['a', 'b'],
        invalid: [
          { line: 'x', error: 'e1' },
          { line: 'y', error: 'e2' },
        ],
      }),
    ).toBe('0 added · 2 already contacted: a, b · 2 invalid: x (e1), y (e2)');
    expect(formatImportSummary({ added: 3, duplicates: [], invalid: [] })).toBe('3 added');
  });

  it('lists the banners: dry run or live, auto-pause reason, and pauses that have not ended', () => {
    const opts = { dryRun: false, now: NOW, timezone: 'Europe/Paris' };
    const idle = { pauseReason: null, invitesPausedUntil: null, messagesPausedUntil: null };
    // The mode is always said: a missing banner must never be the only sign that sends are real.
    expect(dashboardBanners(idle, opts)).toEqual(['Live: actions are sent to LinkedIn']);
    expect(dashboardBanners(idle, { ...opts, dryRun: true })).toEqual(['Dry run: nothing is sent to LinkedIn']);
    expect(
      dashboardBanners(
        {
          pauseReason: 'Auto-paused after 3 Unipile errors in a row (last: http_503)',
          invitesPausedUntil: new Date('2026-11-18T07:30:00Z'),
          messagesPausedUntil: new Date('2026-11-17T10:00:00Z'),
        },
        { ...opts, dryRun: true },
      ),
    ).toEqual([
      'Dry run: nothing is sent to LinkedIn',
      'Auto-paused after 3 Unipile errors in a row (last: http_503)',
      'Invites paused until 2026-11-18 08:30',
      'Messages paused until 2026-11-17 11:00',
    ]);
    expect(dashboardBanners({ ...idle, invitesPausedUntil: NOW, messagesPausedUntil: new Date('2026-11-17T08:00:00Z') }, opts)).toEqual([
      'Live: actions are sent to LinkedIn',
    ]);
  });
});
