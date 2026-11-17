import type { Lead } from '@/db/schema';
import type { Settings } from '@/lib/settings/settings';
import { INVITE_NOTE_MAX_LENGTH, renderTemplate, type RenderResult, type TemplateValues } from '@/lib/templates/render';

export type LeadVariableFields = Pick<Lead, 'firstName' | 'lastName' | 'headline' | 'company' | 'position' | 'location'>;

export function leadTemplateValues(lead: LeadVariableFields): TemplateValues {
  return {
    first_name: lead.firstName,
    last_name: lead.lastName,
    headline: lead.headline,
    company: lead.company,
    position: lead.position,
    location: lead.location,
  };
}

export function renderForLead(template: string, lead: LeadVariableFields): RenderResult {
  return renderTemplate(template, leadTemplateValues(lead));
}

/**
 * Renders every template this lead will receive. Missing variables win over an invalid template,
 * which wins over an invite note that is too long.
 */
export function checkLeadTemplates(
  lead: LeadVariableFields,
  settings: Settings,
  opts: { includeInvite: boolean },
): { ok: true } | { ok: false; reason: string } {
  const { inviteNote, firstMessage, followup1, followup2 } = settings.templates;
  const note = opts.includeInvite ? renderForLead(inviteNote, lead) : null;
  const results = [firstMessage, followup1, followup2].map((template) => renderForLead(template, lead));
  if (note) results.unshift(note);

  const missing: string[] = [];
  for (const result of results) {
    if (result.ok || result.reason !== 'missing_variable') continue;
    for (const name of result.missing) if (!missing.includes(name)) missing.push(name);
  }
  if (missing.length > 0) return { ok: false, reason: `missing_variable: ${missing.join(', ')}` };
  if (results.some((result) => !result.ok)) return { ok: false, reason: 'invalid_template' };

  if (note?.ok && note.text.length > INVITE_NOTE_MAX_LENGTH) {
    return { ok: false, reason: `note_too_long: ${note.text.length}/${INVITE_NOTE_MAX_LENGTH}` };
  }
  return { ok: true };
}
