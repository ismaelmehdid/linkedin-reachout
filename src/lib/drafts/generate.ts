import type { LeadContext } from '@/db/schema';
import type { Db } from '@/db/types';
import { DraftWriterError, type DraftTexts, type DraftWriter } from '@/lib/openai/client';
import { INVITE_NOTE_MAX_LENGTH } from '@/lib/templates/render';
import { buildDraftPrompt } from './prompt';
import { claimNextDraft, failDraft, saveGeneratedDraft } from './repo';
import { checkDraftTexts } from './validate';

export type GenerateResult = { status: 'none_left' } | { status: 'ready' | 'failed'; leadId: number; error?: string };

const trimmed = (texts: DraftTexts): DraftTexts => ({ inviteNote: texts.inviteNote.trim(), firstMessage: texts.firstMessage.trim() });

/** `too_long`: only the note is wrong, by being over the limit, which one more request can fix. */
function judge(texts: DraftTexts): 'ok' | 'too_long' | 'invalid' {
  if (checkDraftTexts(texts).length === 0) return 'ok';
  const tooLong = texts.inviteNote.length > INVITE_NOTE_MAX_LENGTH;
  return tooLong && checkDraftTexts({ ...texts, inviteNote: 'x' }).length === 0 ? 'too_long' : 'invalid';
}

/** Drafts that pass the checks, with one retry for a note over the limit. Throws a `DraftWriterError` with a short code. */
async function writeDrafts(writer: DraftWriter, aboutMe: string, context: LeadContext): Promise<DraftTexts> {
  const write = async (previousNoteLength?: number) =>
    trimmed(await writer.write(buildDraftPrompt(aboutMe, context, { previousNoteLength })));

  let texts = await write();
  let verdict = judge(texts);
  if (verdict === 'too_long') {
    texts = await write(texts.inviteNote.length);
    verdict = judge(texts);
  }
  if (verdict === 'too_long') throw new DraftWriterError(`note_too_long: ${texts.inviteNote.length}/${INVITE_NOTE_MAX_LENGTH}`);
  if (verdict === 'invalid') throw new DraftWriterError('invalid_output', 'The drafts failed the checks');
  return texts;
}

/**
 * Takes one lead waiting for drafts, writes them and stores them as `ready`, or fails the lead with a short
 * reason. `now` is read for each write, since a generation can take a minute.
 */
export async function generateOneDraft(opts: {
  db: Db;
  writer: DraftWriter;
  aboutMe: string;
  now: () => Date;
}): Promise<GenerateResult> {
  const { db, writer, aboutMe, now } = opts;
  const lead = await claimNextDraft(db, now());
  if (lead === null) return { status: 'none_left' };

  const fail = async (error: string): Promise<GenerateResult> => {
    await failDraft(db, lead.id, error, now());
    return { status: 'failed', leadId: lead.id, error };
  };

  if (lead.context === null) return fail('missing_context');

  let texts: DraftTexts;
  try {
    texts = await writeDrafts(writer, aboutMe, lead.context);
  } catch (err) {
    // Any other error could carry anything, so only its existence is stored.
    return fail(err instanceof DraftWriterError ? err.code : 'unexpected_error');
  }

  if (!(await saveGeneratedDraft(db, lead.id, texts, now()))) {
    // The owner edited, requeued or removed the lead meanwhile: their change stands.
    return { status: 'failed', leadId: lead.id, error: 'lead_changed' };
  }
  return { status: 'ready', leadId: lead.id };
}
