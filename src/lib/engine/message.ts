import type { Lead } from '@/db/schema';
import type { Settings } from '@/lib/settings/settings';
import type { ChatMessage, UnipileClient } from '@/lib/unipile/types';
import type { EngineDeps } from './deps';
import { logEvent } from './events';
import { failLead, handleActionError, updateLeadIfStatus, type ActionOutcome } from './failure';
import { renderForLead } from './lead-templates';
import { resetErrorStreak } from './state';
import { nextDueAfterSend, statusAfterMessage, type MessageStep } from './steps';

const TEMPLATE_BY_STEP = {
  first_message: 'firstMessage',
  followup_1: 'followup1',
  followup_2: 'followup2',
} as const satisfies Record<MessageStep, keyof Settings['templates']>;

/** How many of the chat's latest messages the reply check reads. */
const REPLY_CHECK_MESSAGE_LIMIT = 50;

/**
 * The time of the earliest message from the lead after its sequence started, or null when there is none.
 * The earliest one is the reply the webhook would have recorded. Both unknowns fail safe, so nothing goes
 * to someone who may have written: without a sequence start every message from the lead counts, and a
 * message whose timestamp cannot be parsed counts as sent at `now`.
 */
function firstReplyAt(messages: ChatMessage[], sequenceStartedAt: Date | null, now: Date): Date | null {
  const after = sequenceStartedAt?.getTime() ?? -Infinity;
  let first: Date | null = null;
  for (const message of messages) {
    if (message.isSender) continue;
    const sentAt = new Date(message.timestamp);
    const unparsable = Number.isNaN(sentAt.getTime());
    if (!unparsable && sentAt.getTime() <= after) continue;
    const at = unparsable ? now : sentAt;
    if (first === null || at.getTime() < first.getTime()) first = at;
  }
  return first;
}

/**
 * Sends in the lead's chat when it has one, otherwise starts a chat with the lead.
 * Resolves to the chat id, or to null without sending anything when there is nowhere to send.
 */
async function sendText(unipile: UnipileClient, lead: Lead, text: string): Promise<string | null> {
  if (lead.chatId !== null) {
    await unipile.sendMessage(lead.chatId, text);
    return lead.chatId;
  }
  if (lead.providerId !== null) return (await unipile.startChat(lead.providerId, text)).chatId;
  return null;
}

/**
 * Sends the first message or a follow-up. When the lead already has a chat (for the first message, the
 * chat of an invite note), it reads it first, so a reply whose webhook was missed stops the sequence
 * instead of getting another message.
 */
export async function runMessageAction(deps: EngineDeps, lead: Lead, step: MessageStep, settings: Settings): Promise<ActionOutcome> {
  const { db } = deps;
  const now = deps.now();
  const outcome = (result: ActionOutcome['result']): ActionOutcome => ({ leadId: lead.id, result });
  const onUnipileError = (err: unknown) => handleActionError(deps, { lead, kind: 'message', settings }, err);

  if (lead.chatId !== null) {
    let messages: ChatMessage[];
    try {
      messages = await deps.unipile.listChatMessages(lead.chatId, REPLY_CHECK_MESSAGE_LIMIT);
    } catch (err) {
      return onUnipileError(err);
    }
    const repliedAt = firstReplyAt(messages, lead.sequenceStartedAt, now);
    if (repliedAt !== null) {
      const marked = await updateLeadIfStatus(
        db,
        lead,
        { status: 'replied', nextActionAt: null, lastAction: 'reply_received', lastActionAt: repliedAt },
        now,
      );
      return outcome(marked ? 'replied' : 'superseded');
    }
  }

  const rendered = renderForLead(settings.templates[TEMPLATE_BY_STEP[step]], lead);
  if (!rendered.ok) {
    const reason = rendered.reason === 'missing_variable' ? `missing_variable: ${rendered.missing.join(', ')}` : 'invalid_template';
    await failLead(db, lead, reason, now);
    return outcome('failed');
  }

  let chatId: string | null;
  try {
    chatId = await sendText(deps.unipile, lead, rendered.text);
  } catch (err) {
    return onUnipileError(err);
  }
  if (chatId === null) {
    // An accepted lead always has the provider id its invite stored; this only guards a broken row.
    await failLead(db, lead, 'missing_provider_id', now);
    return outcome('failed');
  }

  // Logged before the status update: the message went out, so the daily cap counts it either way.
  await logEvent(db, { type: 'message_sent', at: now, leadId: lead.id, payload: { step, text: rendered.text, dryRun: deps.dryRun } });
  const status = statusAfterMessage(step);
  const marked = await updateLeadIfStatus(
    db,
    lead,
    {
      status,
      chatId,
      nextActionAt: nextDueAfterSend(status, now, settings),
      retryCount: 0,
      lastAction: step,
      lastActionAt: now,
    },
    now,
  );
  await resetErrorStreak(db);
  return outcome(marked ? 'messaged' : 'superseded');
}
