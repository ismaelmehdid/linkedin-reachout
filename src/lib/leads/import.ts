import { inArray, sql } from 'drizzle-orm';
import { leads, type NewLead } from '@/db/schema';
import type { Db } from '@/db/types';
import { parseLinkedInProfileUrl } from './url';

export type ImportResult = {
  added: number;
  duplicates: string[];
  invalid: { line: string; error: string }[];
};

/** A parsed profile to add, with the lead columns it starts with besides its slug and URL. */
export type LeadCandidate = {
  slug: string;
  url: string;
  values: Omit<NewLead, 'slug' | 'linkedinUrl'>;
};

/**
 * Inserts the candidates that are not leads yet. A slug seen earlier in `candidates`, one already in the
 * database (whatever its status or letter case), or one a concurrent import inserted first is reported in
 * `duplicates`, in that order.
 */
export async function addNewLeads(db: Db, candidates: LeadCandidate[]): Promise<{ added: number; duplicates: string[] }> {
  const duplicates: string[] = [];
  const unique: LeadCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.slug.toLowerCase();
    if (seen.has(key)) {
      duplicates.push(candidate.slug);
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }

  if (unique.length === 0) return { added: 0, duplicates };

  const existing = await db
    .select({ slug: leads.slug })
    .from(leads)
    .where(
      inArray(
        sql`lower(${leads.slug})`,
        unique.map((c) => c.slug.toLowerCase()),
      ),
    );
  const existingKeys = new Set(existing.map((row) => row.slug.toLowerCase()));

  const fresh = unique.filter((c) => {
    if (existingKeys.has(c.slug.toLowerCase())) {
      duplicates.push(c.slug);
      return false;
    }
    return true;
  });

  if (fresh.length === 0) return { added: 0, duplicates };

  // A concurrent import may insert the same slug between the check above and this insert.
  const inserted = await db
    .insert(leads)
    .values(fresh.map((c) => ({ ...c.values, slug: c.slug, linkedinUrl: c.url })))
    .onConflictDoNothing()
    .returning({ slug: leads.slug });
  const insertedKeys = new Set(inserted.map((row) => row.slug.toLowerCase()));
  for (const c of fresh) {
    if (!insertedKeys.has(c.slug.toLowerCase())) duplicates.push(c.slug);
  }

  return { added: inserted.length, duplicates };
}

export async function importLeads(db: Db, text: string, now: Date): Promise<ImportResult> {
  const invalid: ImportResult['invalid'] = [];
  const candidates: LeadCandidate[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parsed = parseLinkedInProfileUrl(line);
    if (!parsed.ok) {
      invalid.push({ line, error: parsed.error });
      continue;
    }
    candidates.push({ slug: parsed.slug, url: parsed.url, values: { status: 'queued', nextActionAt: now } });
  }

  const { added, duplicates } = await addNewLeads(db, candidates);
  return { added, duplicates, invalid };
}
