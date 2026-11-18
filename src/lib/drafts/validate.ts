import { INVITE_NOTE_MAX_LENGTH } from '@/lib/templates/render';

export const FIRST_MESSAGE_MAX_LENGTH = 8000;

/**
 * Why a pair of drafts cannot be stored as sendable, one line per problem; empty when they can. Used on
 * a generated draft and on an edit the owner saves. Callers trim the texts first.
 */
export function checkDraftTexts(texts: { inviteNote: string; firstMessage: string }): string[] {
  const errors: string[] = [];
  const check = (label: string, text: string, max: number) => {
    if (text.trim() === '') errors.push(`${label}: must not be empty`);
    if (text.length > max) errors.push(`${label}: must be ${max} characters or less (it has ${text.length})`);
    if (text.includes('{{')) errors.push(`${label}: must not contain {{`);
  };
  check('Invite note', texts.inviteNote, INVITE_NOTE_MAX_LENGTH);
  check('First message', texts.firstMessage, FIRST_MESSAGE_MAX_LENGTH);
  return errors;
}
