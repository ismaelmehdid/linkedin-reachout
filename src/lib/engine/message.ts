import type { Lead } from '@/db/schema';
import type { Settings } from '@/lib/settings/settings';
import { DRY_RUN_ID_PREFIX } from '@/lib/unipile/dry-run';
import type { ChatMessage } from '@/lib/unipile/types';
import type { EngineDeps } from './deps';
import { logEvent } from './events';
import { failLead, handleActionError, updateLeadIfStatus, type ActionOutcome } from './failure';
import { renderForLead } from './lead-templates';
import { resetErrorStreak } from './state';
import { ECHO_WINDOW_MS, nextDueAfterSend, statusAfterMessage, type MessageStep } from './steps';

const TEMPLATE_BY_STEP = {
  first_message: 'firstMessage',
  followup_1: 'followup1',
  followup_2: 'followup2',
} as const satisfies Record<MessageStep, keyof Settings['templates']>;

/** The status a lead keeps while a follow-up is pending: the one its previous message left. */
const STATUS_BEFORE_FOLLOWUP = {
  followup_1: 'messaged',
  followup_2: 'followup_1',
} as const satisfies Record<Exclude<MessageStep, 'first_message'>, 'messaged' | 'followup_1'>;

/** How many of the chat's messages are read before a send. */
const CHAT_READ_LIMIT = 50;

type DatedMessage = { at: Date; text: string | null };

/**
 * The messages of one side of the chat sent after `after`, each with its time. Both unknowns fail
 * safe, so nothing goes out on a guess: without `after` every message counts, and a message whose
 * timestamp cannot be parsed counts as sent at `now`.
 */
function messagesAfter(messages: ChatMessage[], side: 'lead' | 'owner', after: Date | null, now: Date): DatedMessage[] {
  const floor = after?.getTime() ?? -Infinity;
  const found: DatedMessage[] = [];
  for (const message of messages) {
    if (message.isSender !== (side === 'owner')) continue;
    const sentAt = new Date(message.timestamp);
    const unparsable = Number.isNaN(sentAt.getTime());
    if (!unparsable && sentAt.getTime() <= floor) continue;
    found.push({ at: unparsable ? now : sentAt, text: message.text });
  }
  return found;
}

const earliest = (messages: DatedMessage[]) => messages.reduce((a, b) => (b.at.getTime() < a.at.getTime() ? b : a));

const newest = (messages: DatedMessage[]) => messages.reduce((a, b) => (b.at.getTime() > a.at.getTime() ? b : a));

const shifted = (date: Date | null, ms: number) => (date === null ? null : new Date(date.getTime() + ms));

/** LinkedIn may change the spacing of a message, so two texts are the same when their words are. */
const normalizeText = (text: string) => text.trim().replace(/\s+/g, ' ');

/**
 * Sends the first message or a follow-up. Before any send it finds the chat with the lead and reads it
 * (spec §6 "Never twice", §7), and sends nothing when the chat shows that:
 * - the lead wrote: the sequence stops, in case the reply webhook was missed;
 * - this step's text is already there: an earlier send whose record was lost. The step is recorded;
 * - the owner wrote by hand and no webhook reported it: that counts as a manual message.
 * The text comparison can only ever skip a send. It is never the reason a message goes out.
 */
export async function runMessageAction(deps: EngineDeps, lead: Lead, step: MessageStep, settings: Settings): Promise<ActionOutcome> {
  const { db } = deps;
  const now = deps.now();
  const outcome = (result: ActionOutcome['result']): ActionOutcome => ({ leadId: lead.id, result });
  const onUnipileError = (err: unknown) => handleActionError(deps, { lead, kind: 'message', settings }, err);

  /** Records the step as sent at `sentAt`: now for a send, the message's own time for one found in the chat. */
  const recordStep = async (text: string, sentAt: Date, inChatId: string | null, recovered: boolean): Promise<ActionOutcome> => {
    // Logged before the status update: the message went out, so the daily cap counts it either way.
    await logEvent(db, {
      type: 'message_sent',
      at: now,
      leadId: lead.id,
      payload: { step, text, dryRun: deps.dryRun, ...(recovered ? { recovered: true } : {}) },
    });
    const status = statusAfterMessage(step);
    const marked = await updateLeadIfStatus(
      db,
      lead,
      { status, chatId: inChatId, nextActionAt: nextDueAfterSend(status, sentAt, settings, deps.random), retryCount: 0, lastAction: step, lastActionAt: sentAt },
      now,
    );
    await resetErrorStreak(db);
    return outcome(marked ? 'messaged' : 'superseded');
  };

  // 1. Find the chat. An acceptance seen by the relation webhook or the poll brings no chat id.
  let chatId = lead.chatId;
  if (chatId === null && lead.providerId !== null) {
    try {
      chatId = await deps.unipile.findChatWithAttendee(lead.providerId);
    } catch (err) {
      return onUnipileError(err);
    }
    if (chatId !== null && !(await updateLeadIfStatus(db, lead, { chatId }, now))) return outcome('superseded');
  }

  // 2. Read the chat, when there is one.
  let messages: ChatMessage[] = [];
  if (chatId !== null) {
    try {
      messages = await deps.unipile.listChatMessages(chatId, CHAT_READ_LIMIT, lead.sequenceStartedAt ?? undefined);
    } catch (err) {
      return onUnipileError(err);
    }
  }

  // 3. A reply. The earliest one is the reply the webhook would have recorded.
  const replies = messagesAfter(messages, 'lead', lead.sequenceStartedAt, now);
  if (replies.length > 0) {
    const marked = await updateLeadIfStatus(
      db,
      lead,
      { status: 'replied', nextActionAt: null, lastAction: 'reply_received', lastActionAt: earliest(replies).at },
      now,
    );
    return outcome(marked ? 'replied' : 'superseded');
  }

  // The owner's messages this step has to account for: everything since the sequence started for the first
  // message, everything after the previous step and its echo window for a follow-up.
  const isFirstMessage = step === 'first_message';
  const candidates = messagesAfter(messages, 'owner', isFirstMessage ? lead.sequenceStartedAt : shifted(lead.lastActionAt, ECHO_WINDOW_MS), now);
  const rendered = renderForLead(settings.templates[TEMPLATE_BY_STEP[step]], lead);

  // 4. Already sent. When the record of a follow-up was lost but its webhook arrived, the webhook saw a
  // manual message and moved `lastActionAt` onto it, out of the candidates. So after a manual message the
  // text is also compared with the message that was recorded as manual.
  if (rendered.ok) {
    const comparable =
      !isFirstMessage && lead.lastAction === 'manual_message'
        ? messagesAfter(messages, 'owner', shifted(lead.lastActionAt, -ECHO_WINDOW_MS), now)
        : candidates;
    const wanted = normalizeText(rendered.text);
    const alreadySent = comparable.filter((message) => message.text !== null && normalizeText(message.text) === wanted);
    if (alreadySent.length > 0) return recordStep(rendered.text, newest(alreadySent).at, chatId, true);
  }

  // 5. A manual message. The note of the invite is the one own message expected before the first message.
  const expected = isFirstMessage && lead.inviteSentAt !== null ? 1 : 0;
  if (candidates.length > expected) {
    const manualAt = newest(candidates).at;
    // Before the first message it replaces it; after that it restarts the wait for the same follow-up.
    await updateLeadIfStatus(
      db,
      lead,
      isFirstMessage
        ? { status: 'messaged', nextActionAt: nextDueAfterSend('messaged', manualAt, settings, deps.random), lastAction: 'manual_message', lastActionAt: manualAt }
        : { nextActionAt: nextDueAfterSend(STATUS_BEFORE_FOLLOWUP[step], manualAt, settings, deps.random), lastAction: 'manual_message', lastActionAt: manualAt },
      now,
    );
    return outcome('superseded');
  }

  // 6. Render and send.
  if (!rendered.ok) {
    const reason = rendered.reason === 'missing_variable' ? `missing_variable: ${rendered.missing.join(', ')}` : 'invalid_template';
    await failLead(db, lead, reason, now);
    return outcome('failed');
  }
  if (chatId === null && lead.providerId === null) {
    // An accepted lead always has the provider id its invite stored; this only guards a broken row.
    await failLead(db, lead, 'missing_provider_id', now);
    return outcome('failed');
  }

  // The chat the text went to. Unipile may accept a new chat without naming it: the send still counts,
  // and the next step finds the chat in step 1.
  let sentIn = chatId;
  try {
    if (chatId !== null) await deps.unipile.sendMessage(chatId, rendered.text);
    else if (lead.providerId !== null) sentIn = (await deps.unipile.startChat(lead.providerId, rendered.text)).chatId;
  } catch (err) {
    return onUnipileError(err);
  }

  // A dry run sent nothing, so its lead must never continue for real: it keeps a dry-run chat id, which
  // Unipile does not know, and the lead's next step fails once the dry run is off.
  const storedChatId = deps.dryRun && sentIn !== null && !sentIn.startsWith(DRY_RUN_ID_PREFIX) ? `${DRY_RUN_ID_PREFIX}${sentIn}` : sentIn;
  return recordStep(rendered.text, now, storedChatId, false);
}
