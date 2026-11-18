// Pure module: no Node, database or React imports. The rules the lead table's draft editor shows; the
// server checks them again on every save.
import { INVITE_NOTE_MAX_LENGTH } from '@/lib/templates/render';

/** The first message is not sent yet while the lead is in one of these. */
const FIRST_MESSAGE_EDITABLE: readonly string[] = ['queued', 'invite_sent', 'accepted', 'already_connected'];

const REGENERABLE: readonly string[] = ['ready', 'approved', 'failed'];

const PREVIEW_LENGTH = 60;

/** The note goes with the invite, so it can change only before it. */
export function canEditInviteNote(status: string): boolean {
  return status === 'queued';
}

export function canEditFirstMessage(status: string): boolean {
  return FIRST_MESSAGE_EDITABLE.includes(status);
}

export function canRegenerate(lead: { status: string; draftStatus: string }): boolean {
  return lead.status === 'queued' && REGENERABLE.includes(lead.draftStatus);
}

export function hasDrafts(lead: {
  draftStatus: string;
  inviteNoteDraft: string | null;
  firstMessageDraft: string | null;
}): boolean {
  return lead.draftStatus !== 'none' && lead.inviteNoteDraft !== null && lead.firstMessageDraft !== null;
}

/** The note is saved trimmed, so it is counted trimmed. */
export function noteLength(note: string): number {
  return note.trim().length;
}

export function noteTooLong(note: string): boolean {
  return noteLength(note) > INVITE_NOTE_MAX_LENGTH;
}

export function notePreview(note: string): string {
  const text = note.trim();
  if (text.length <= PREVIEW_LENGTH) return text;
  const cut = text.slice(0, PREVIEW_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
