'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { requireSession } from '@/lib/auth/require-session';
import { setRunningUnlessBlocked } from '@/lib/engine/running';
import { importLeads, type ImportResult } from '@/lib/leads/import';
import { importFounders, type FounderImportResult } from '@/lib/leads/import-founders';
import { removeLead, retryFailedLead, setLeadPaused } from '@/lib/leads/repo';

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

/** One batch of the founders the browser read from the scraper's files; `importFounders` checks every record. */
export async function importFoundersAction(records: unknown): Promise<FounderImportResult> {
  await requireSession();
  const result = await importFounders(await getDb(), records, new Date());
  revalidatePath('/');
  return result;
}

/**
 * `running` is the state the button asks for, never a toggle: a page that still shows "Pause" after the
 * engine auto-paused must not restart sending. `false` always pauses; `true` returns the start blockers
 * without starting when there are any.
 */
export async function setRunningAction(running: boolean): Promise<{ blockers: string[] }> {
  await requireSession();
  if (typeof running !== 'boolean') throw new Error('Invalid running state');
  const result = await setRunningUnlessBlocked(await getDb(), running);
  revalidatePath('/');
  return result;
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
