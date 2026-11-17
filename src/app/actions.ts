'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { requireSession } from '@/lib/auth/require-session';
import { getAppState, setRunning } from '@/lib/engine/state';
import { importLeads, type ImportResult } from '@/lib/leads/import';
import { removeLead, retryFailedLead, setLeadPaused } from '@/lib/leads/repo';
import { getSettings } from '@/lib/settings/repo';
import { startBlockers } from '@/lib/settings/settings';

// Every action below calls requireSession() first: an action runs as a POST to the page that sends it,
// so the request filter alone does not protect it.

/** An action's arguments come from the client, so a lead id is checked before it reaches a query. */
function checkLeadId(id: unknown): number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid lead id');
  return id;
}

export async function importLeadsAction(_prev: ImportResult | null, formData: FormData): Promise<ImportResult> {
  await requireSession();
  const text = formData.get('urls');
  const result = await importLeads(await getDb(), typeof text === 'string' ? text : '', new Date());
  revalidatePath('/');
  return result;
}

/** Pauses when running. Otherwise starts, unless the settings block it: then it returns why, and stays paused. */
export async function toggleRunningAction(): Promise<{ blockers: string[] }> {
  await requireSession();
  const db = await getDb();
  let blockers: string[] = [];
  if ((await getAppState(db)).running) {
    await setRunning(db, false);
  } else {
    blockers = startBlockers(await getSettings(db));
    if (blockers.length === 0) await setRunning(db, true);
  }
  revalidatePath('/');
  return { blockers };
}

export async function pauseLeadAction(id: number): Promise<void> {
  await requireSession();
  const leadId = checkLeadId(id);
  await setLeadPaused(await getDb(), leadId, true, new Date());
  revalidatePath('/');
}

export async function resumeLeadAction(id: number): Promise<void> {
  await requireSession();
  const leadId = checkLeadId(id);
  await setLeadPaused(await getDb(), leadId, false, new Date());
  revalidatePath('/');
}

/** Does nothing when the lead is no longer failed; the refreshed table shows its status. */
export async function retryLeadAction(id: number): Promise<void> {
  await requireSession();
  const leadId = checkLeadId(id);
  await retryFailedLead(await getDb(), leadId, new Date());
  revalidatePath('/');
}

export async function removeLeadAction(id: number): Promise<void> {
  await requireSession();
  const leadId = checkLeadId(id);
  await removeLead(await getDb(), leadId);
  revalidatePath('/');
}
