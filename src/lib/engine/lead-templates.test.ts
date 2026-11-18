import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings/settings';
import { checkLeadTemplates, leadInviteNote, leadMessageText, renderForLead } from './lead-templates';

const lead = { firstName: 'Jane', lastName: 'Doe', headline: null, company: 'Acme', position: null, location: null };
const withT = (t: Partial<Settings['templates']>) => ({ ...DEFAULT_SETTINGS, templates: { ...DEFAULT_SETTINGS.templates, ...t } });

describe('lead templates', () => {
  it('renders a template with the lead fields', () =>
    expect(renderForLead('{{first_name}} {{last_name}} at {{company}}, {{position|team}}', lead)).toEqual({ ok: true, text: 'Jane Doe at Acme, team' }));

  it('passes when every template renders', () => expect(checkLeadTemplates(lead, DEFAULT_SETTINGS, { includeInvite: true })).toEqual({ ok: true }));

  it('lists missing variables across all templates', () =>
    expect(checkLeadTemplates(lead, withT({ followup2: 'Re {{position}} / {{headline}}' }), { includeInvite: true }))
      .toEqual({ ok: false, reason: 'missing_variable: position, headline' }));

  it('fails when a lead value would put a raw tag in the text', () =>
    expect(checkLeadTemplates({ ...lead, firstName: '{{x}}' }, DEFAULT_SETTINGS, { includeInvite: true }))
      .toEqual({ ok: false, reason: 'invalid_template' }));

  it('fails when the rendered invite note is over 300 characters', () =>
    expect(checkLeadTemplates({ ...lead, company: 'x'.repeat(300) }, withT({ inviteNote: 'Hi {{company}}' }), { includeInvite: true }))
      .toEqual({ ok: false, reason: 'note_too_long: 303/300' }));

  it('skips the invite note for leads that are already connected', () =>
    expect(checkLeadTemplates(lead, withT({ inviteNote: '{{position}}' }), { includeInvite: false })).toEqual({ ok: true }));

  describe('an AI lead, whose drafts are approved', () => {
    const ai = { ...lead, draftStatus: 'approved' as const, inviteNoteDraft: ' Hi Jane,\n saw Acme ', firstMessageDraft: 'Thanks for connecting, Jane' };
    /** Invite-note and first-message templates that this lead could never render. */
    const unrenderable = withT({ inviteNote: '{{position}}', firstMessage: '{{headline}} {{' });

    it('uses the drafts as written and the templates for the follow-ups', () => {
      expect(leadInviteNote(ai, unrenderable)).toEqual({ ok: true, text: ' Hi Jane,\n saw Acme ' });
      expect(leadMessageText(ai, 'first_message', unrenderable)).toEqual({ ok: true, text: 'Thanks for connecting, Jane' });
      expect(leadMessageText(ai, 'followup_1', unrenderable)).toEqual(renderForLead(DEFAULT_SETTINGS.templates.followup1, lead));
    });
    it('checks only the drafts and the follow-up templates', () =>
      expect(checkLeadTemplates(ai, unrenderable, { includeInvite: true })).toEqual({ ok: true }));
    it('still fails when a follow-up template misses a variable', () =>
      expect(checkLeadTemplates(ai, withT({ followup1: 'About {{position}}' }), { includeInvite: true })).toEqual({ ok: false, reason: 'missing_variable: position' }));
    it.each([null, '', '  \n '])('fails with missing_draft when the invite note draft is %j', (note) =>
      expect(checkLeadTemplates({ ...ai, inviteNoteDraft: note }, DEFAULT_SETTINGS, { includeInvite: true })).toEqual({ ok: false, reason: 'missing_draft' }));
    it.each([null, ' '])('fails with missing_draft when the first message draft is %j, even without an invite', (message) =>
      expect(checkLeadTemplates({ ...ai, firstMessageDraft: message }, DEFAULT_SETTINGS, { includeInvite: false })).toEqual({ ok: false, reason: 'missing_draft' }));
    it('skips the invite note draft for a lead that is already connected', () =>
      expect(checkLeadTemplates({ ...ai, inviteNoteDraft: null }, DEFAULT_SETTINGS, { includeInvite: false })).toEqual({ ok: true }));
    it('fails a draft that holds a raw tag', () => {
      expect(checkLeadTemplates({ ...ai, inviteNoteDraft: 'Hi {{first_name}}' }, DEFAULT_SETTINGS, { includeInvite: true })).toEqual({ ok: false, reason: 'invalid_template' });
      expect(checkLeadTemplates({ ...ai, firstMessageDraft: 'Thanks {{x' }, DEFAULT_SETTINGS, { includeInvite: false })).toEqual({ ok: false, reason: 'invalid_template' });
    });
    it('fails an invite note draft over 300 characters', () =>
      expect(checkLeadTemplates({ ...ai, inviteNoteDraft: 'x'.repeat(301) }, DEFAULT_SETTINGS, { includeInvite: true })).toEqual({ ok: false, reason: 'note_too_long: 301/300' }));
    it('renders the templates for a pasted lead, whose draft status is none', () => {
      expect(leadInviteNote({ ...ai, draftStatus: 'none' }, DEFAULT_SETTINGS)).toEqual(renderForLead(DEFAULT_SETTINGS.templates.inviteNote, lead));
      expect(leadMessageText({ ...ai, draftStatus: 'none' }, 'first_message', DEFAULT_SETTINGS)).toEqual(renderForLead(DEFAULT_SETTINGS.templates.firstMessage, lead));
    });
    it.each(['pending', 'generating', 'ready', 'failed'] as const)('never falls back to a template for a founder whose drafts are %s', (draftStatus) => {
      const founder = { ...ai, draftStatus };
      expect(leadInviteNote(founder, DEFAULT_SETTINGS)).toEqual({ ok: false, reason: 'draft_not_approved' });
      expect(leadMessageText(founder, 'first_message', DEFAULT_SETTINGS)).toEqual({ ok: false, reason: 'draft_not_approved' });
      expect(leadMessageText(founder, 'followup_1', DEFAULT_SETTINGS)).toEqual(renderForLead(DEFAULT_SETTINGS.templates.followup1, lead));
      expect(checkLeadTemplates({ ...founder, firstMessageDraft: null }, DEFAULT_SETTINGS, { includeInvite: false })).toEqual({ ok: false, reason: 'draft_not_approved' });
    });
  });
});
