import type { DraftStatus } from '@/db/schema';
import type { Db } from '@/db/types';
import { generateOneDraft } from '@/lib/drafts/generate';
import { countDrafts } from '@/lib/drafts/repo';
import { createDraftWriter } from '@/lib/openai/client';
import { readOpenAiConfig } from '@/lib/openai/config';
import { getSettings } from '@/lib/settings/repo';

// Shared by generateNextDraftAction and POST /api/drafts/generate, so the two can never drift. Neither the
// session check nor the revalidation is done here: each caller does its own.

export type DraftCounts = Record<DraftStatus, number>;

export type GenerateNextResult = {
  status: 'none_left' | 'ready' | 'failed' | 'blocked';
  leadId: number | null;
  error: string | null;
  counts: DraftCounts;
};

/**
 * Takes one lead waiting for drafts and writes them. `blocked` (before any lead is taken) when the OpenAI
 * key or the owner's "About me" is missing. The caller asks again until `none_left`.
 */
export async function generateNextDraft(db: Db): Promise<GenerateNextResult> {
  const { apiKey, model } = readOpenAiConfig();
  const blocked = async (error: string) => ({ status: 'blocked' as const, leadId: null, error, counts: await countDrafts(db) });
  if (apiKey === null) return blocked('missing_api_key');
  const { aboutMe } = await getSettings(db);
  if (aboutMe.trim() === '') return blocked('missing_about_me');

  const result = await generateOneDraft({
    db,
    writer: createDraftWriter({ apiKey, model }),
    aboutMe,
    // Only server entry points read the real clock; the library receives it.
    now: () => new Date(),
  });
  if (result.status === 'none_left') return { status: 'none_left', leadId: null, error: null, counts: await countDrafts(db) };
  return { status: result.status, leadId: result.leadId, error: result.error ?? null, counts: await countDrafts(db) };
}

/** True when a generation wrote to a lead, so the dashboard must be revalidated. */
export function wroteToLead(result: GenerateNextResult): boolean {
  return result.status === 'ready' || result.status === 'failed';
}
