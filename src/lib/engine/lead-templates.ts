import type { Lead } from '@/db/schema';
import type { Settings } from '@/lib/settings/settings';
import { INVITE_NOTE_MAX_LENGTH, renderTemplate, type RenderResult, type TemplateValues } from '@/lib/templates/render';
import type { MessageStep } from './steps';

export type LeadVariableFields = Pick<Lead, 'firstName' | 'lastName' | 'headline' | 'company' | 'position' | 'location'>;

/** What decides the texts a lead gets. A lead without draft fields is treated as one with no drafts. */
export type LeadTextFields = LeadVariableFields & Partial<Pick<Lead, 'draftStatus' | 'inviteNoteDraft' | 'firstMessageDraft'>>;

/**
 * The text a lead gets, or why it cannot be sent: a template result, or for an AI lead `draft_not_approved`
 * (its drafts are not approved yet) or `missing_draft` (approved, but the draft is blank).
 */
export type LeadTextResult = RenderResult | { ok: false; reason: 'draft_not_approved' | 'missing_draft' };

const TEMPLATE_BY_STEP = {
  first_message: 'firstMessage',
  followup_1: 'followup1',
  followup_2: 'followup2',
} as const satisfies Record<MessageStep, keyof Settings['templates']>;

const MESSAGE_STEPS = Object.keys(TEMPLATE_BY_STEP) as MessageStep[];

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
 * An AI lead: an uploaded founder, whose invite note and first message are its drafts once approved, and
 * never the templates. A lead without draft fields, or with `none`, is a pasted lead that uses the templates.
 */
export function isAiLead(lead: LeadTextFields): boolean {
  return lead.draftStatus !== undefined && lead.draftStatus !== 'none';
}

/** A draft goes out as written, and only once approved. It is never empty and never holds a raw tag. */
function draftText(lead: LeadTextFields, draft: string | null | undefined): LeadTextResult {
  if (lead.draftStatus !== 'approved') return { ok: false, reason: 'draft_not_approved' };
  if (draft === null || draft === undefined || draft.trim() === '') return { ok: false, reason: 'missing_draft' };
  if (draft.includes('{{')) return { ok: false, reason: 'invalid_syntax' };
  return { ok: true, text: draft };
}

/** The invite note this lead gets: its approved draft for an AI lead, the rendered template otherwise. The length is not checked here. */
export function leadInviteNote(lead: LeadTextFields, settings: Settings): LeadTextResult {
  return isAiLead(lead) ? draftText(lead, lead.inviteNoteDraft) : renderForLead(settings.templates.inviteNote, lead);
}

/** The text of a message step: the approved draft for an AI lead's first message, the rendered template otherwise. */
export function leadMessageText(lead: LeadTextFields, step: MessageStep, settings: Settings): LeadTextResult {
  if (step === 'first_message' && isAiLead(lead)) return draftText(lead, lead.firstMessageDraft);
  return renderForLead(settings.templates[TEMPLATE_BY_STEP[step]], lead);
}

/** The failure reason stored on a lead whose text cannot be sent. */
export function textFailureReason(result: Exclude<LeadTextResult, { ok: true }>): string {
  if (result.reason === 'missing_variable') return `missing_variable: ${result.missing.join(', ')}`;
  return result.reason === 'invalid_syntax' ? 'invalid_template' : result.reason;
}

/**
 * Checks every text this lead will receive: the templates, or for an AI lead its drafts and the follow-up
 * templates. Drafts that are not approved win over a missing draft, which wins over missing variables, which
 * win over an invalid text, which wins over an invite note that is too long.
 */
export function checkLeadTemplates(
  lead: LeadTextFields,
  settings: Settings,
  opts: { includeInvite: boolean },
): { ok: true } | { ok: false; reason: string } {
  const note = opts.includeInvite ? leadInviteNote(lead, settings) : null;
  const results = MESSAGE_STEPS.map((step) => leadMessageText(lead, step, settings));
  if (note) results.unshift(note);

  for (const reason of ['draft_not_approved', 'missing_draft'] as const) {
    if (results.some((result) => !result.ok && result.reason === reason)) return { ok: false, reason };
  }
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
