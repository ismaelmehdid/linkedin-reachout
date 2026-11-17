import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings/settings';
import { checkLeadTemplates, renderForLead } from './lead-templates';

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
});
