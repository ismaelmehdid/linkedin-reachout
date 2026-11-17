import { and, eq, ne } from 'drizzle-orm';
import { leads, type Lead } from '@/db/schema';
import type { Db } from '@/db/types';
import { addLocalDays } from '@/lib/schedule/window';
import type { Settings } from '@/lib/settings/settings';
import { classifyUnipileError } from '@/lib/unipile/errors';
import type { UnipileProfile } from '@/lib/unipile/types';
import type { EngineDeps } from './deps';
import { logEvent } from './events';
import { failLead, handleActionError, updateLeadIfStatus, type ActionOutcome } from './failure';
import { checkLeadTemplates, renderForLead } from './lead-templates';
import { resetErrorStreak } from './state';

function profileFields(profile: UnipileProfile) {
  return {
    providerId: profile.providerId,
    publicIdentifier: profile.publicIdentifier,
    firstName: profile.firstName,
    lastName: profile.lastName,
    headline: profile.headline,
    location: profile.location,
    company: profile.currentCompany,
    position: profile.currentPosition,
  } satisfies Partial<Lead>;
}

/** The same person pasted under another URL. A retried lead already carries its own provider id. */
async function belongsToAnotherLead(db: Db, providerId: string, leadId: number): Promise<boolean> {
  const [other] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.providerId, providerId), ne(leads.id, leadId)))
    .limit(1);
  return other !== undefined;
}

/** Already a first-degree connection: no invite, the first message is due now. */
async function markAlreadyConnected(deps: EngineDeps, lead: Lead, settings: Settings, now: Date): Promise<ActionOutcome> {
  const check = checkLeadTemplates(lead, settings, { includeInvite: false });
  if (!check.ok) {
    await failLead(deps.db, lead, check.reason, now);
    return { leadId: lead.id, result: 'failed' };
  }
  const marked = await updateLeadIfStatus(
    deps.db,
    lead,
    { status: 'already_connected', sequenceStartedAt: now, nextActionAt: now, retryCount: 0, lastAction: 'already_connected', lastActionAt: now },
    now,
  );
  await resetErrorStreak(deps.db);
  return { leadId: lead.id, result: marked ? 'already_connected' : 'superseded' };
}

/** `invitationId` is null when LinkedIn says this person was already invited recently, or when the answer to the invite held no id. */
function markInviteSent(db: Db, lead: Lead, invitationId: string | null, now: Date, settings: Settings): Promise<boolean> {
  return updateLeadIfStatus(
    db,
    lead,
    {
      status: 'invite_sent',
      invitationId,
      inviteSentAt: now,
      sequenceStartedAt: now,
      nextActionAt: addLocalDays(now, settings.delays.inviteExpiryDays, settings.window.timezone),
      retryCount: 0,
      lastAction: 'invite_sent',
      lastActionAt: now,
    },
    now,
  );
}

/**
 * Fetches the profile, checks every template against it, then sends the invite with its note.
 * All four templates are checked first, so a value a later message needs fails the lead before anyone is contacted.
 */
export async function runInviteAction(deps: EngineDeps, lead: Lead, settings: Settings): Promise<ActionOutcome> {
  const { db } = deps;
  const now = deps.now();
  const outcome = (result: ActionOutcome['result']): ActionOutcome => ({ leadId: lead.id, result });

  let profile: UnipileProfile;
  try {
    profile = await deps.unipile.getProfile(lead.slug);
  } catch (err) {
    return handleActionError(deps, { lead, kind: 'invite', settings }, err);
  }
  await logEvent(db, { type: 'profile_view', at: now, leadId: lead.id });

  if (await belongsToAnotherLead(db, profile.providerId, lead.id)) {
    await failLead(db, lead, 'duplicate_person', now);
    return outcome('failed');
  }

  const fields = profileFields(profile);
  if (!(await updateLeadIfStatus(db, lead, fields, now))) return outcome('superseded');
  const withProfile: Lead = { ...lead, ...fields };

  if (profile.networkDistance === 'FIRST_DEGREE') return markAlreadyConnected(deps, withProfile, settings, now);

  const check = checkLeadTemplates(withProfile, settings, { includeInvite: true });
  const note = renderForLead(settings.templates.inviteNote, withProfile);
  if (!check.ok || !note.ok) {
    // The check covers the note too; `note.ok` is only tested here to narrow its type.
    await failLead(db, withProfile, check.ok ? 'invalid_template' : check.reason, now);
    return outcome('failed');
  }

  // Null when Unipile accepted the invite without naming it; the poll stores the id later.
  let invitationId: string | null;
  try {
    ({ invitationId } = await deps.unipile.sendInvitation(profile.providerId, note.text));
  } catch (err) {
    switch (classifyUnipileError(err)) {
      case 'already_connected':
        return markAlreadyConnected(deps, withProfile, settings, now);
      case 'already_invited':
        return outcome((await markInviteSent(db, withProfile, null, now, settings)) ? 'already_invited' : 'superseded');
      default:
        return handleActionError(deps, { lead: withProfile, kind: 'invite', settings }, err);
    }
  }

  // Logged before the status update: the invite went out, so the caps count it either way.
  await logEvent(db, { type: 'invite_sent', at: now, leadId: lead.id, payload: { text: note.text, dryRun: deps.dryRun } });
  const marked = await markInviteSent(db, withProfile, invitationId, now, settings);
  await resetErrorStreak(db);
  return outcome(marked ? 'invited' : 'superseded');
}
