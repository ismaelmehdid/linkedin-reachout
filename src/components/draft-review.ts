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

/**
 * Whether the row's draft editor can open: for an AI lead whose first message can still change (with
 * empty fields while no draft is written, so the owner can write both by hand), and, once it is sent, for
 * one that holds drafts to read. Never for a pasted lead, which uses the templates.
 */
export function canReview(lead: {
  status: string;
  draftStatus: string;
  inviteNoteDraft: string | null;
  firstMessageDraft: string | null;
}): boolean {
  if (lead.draftStatus === 'none') return false;
  return canEditFirstMessage(lead.status) || lead.inviteNoteDraft !== null || lead.firstMessageDraft !== null;
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

const NOTE_NOT_SENT = 'Not sent: the Invite note template in Settings is sent to uploaded founders.';

/**
 * The line under the note counter while Settings sends the invite-note template to founders, or null. Only
 * while the note can still change: once the invite is out, the setting of that moment chose its note, and
 * today's setting says nothing about it.
 */
export function noteNotSentNotice(status: string, founderNoteFromTemplate: boolean): string | null {
  return founderNoteFromTemplate && canEditInviteNote(status) ? NOTE_NOT_SENT : null;
}

/**
 * The start of a ready note, shown in the Draft cell, or null. Not while Settings sends the invite-note
 * template to founders: that note is not what goes out.
 */
export function readyNotePreview(
  lead: { draftStatus: string; inviteNoteDraft: string | null },
  founderNoteFromTemplate: boolean,
): string | null {
  if (founderNoteFromTemplate || lead.draftStatus !== 'ready' || !lead.inviteNoteDraft) return null;
  return notePreview(lead.inviteNoteDraft);
}
