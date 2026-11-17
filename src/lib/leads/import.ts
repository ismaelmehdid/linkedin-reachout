import { inArray, sql } from 'drizzle-orm';
import { leads } from '@/db/schema';
import type { Db } from '@/db/types';
import { parseLinkedInProfileUrl } from './url';

export type ImportResult = {
  added: number;
  duplicates: string[];
  invalid: { line: string; error: string }[];
};

export async function importLeads(db: Db, text: string, now: Date): Promise<ImportResult> {
  const duplicates: string[] = [];
  const invalid: ImportResult['invalid'] = [];
  const candidates: { slug: string; url: string }[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parsed = parseLinkedInProfileUrl(line);
    if (!parsed.ok) {
      invalid.push({ line, error: parsed.error });
      continue;
    }
    const key = parsed.slug.toLowerCase();
    if (seen.has(key)) {
      duplicates.push(parsed.slug);
      continue;
    }
    seen.add(key);
    candidates.push({ slug: parsed.slug, url: parsed.url });
  }

  if (candidates.length === 0) return { added: 0, duplicates, invalid };

  const existing = await db
    .select({ slug: leads.slug })
    .from(leads)
    .where(
      inArray(
        sql`lower(${leads.slug})`,
        candidates.map((c) => c.slug.toLowerCase()),
      ),
    );
  const existingKeys = new Set(existing.map((row) => row.slug.toLowerCase()));

  const fresh = candidates.filter((c) => {
    if (existingKeys.has(c.slug.toLowerCase())) {
      duplicates.push(c.slug);
      return false;
    }
    return true;
  });

  if (fresh.length === 0) return { added: 0, duplicates, invalid };

  // A concurrent import may insert the same slug between the check above and this insert.
  const inserted = await db
    .insert(leads)
    .values(
      fresh.map((c) => ({
        slug: c.slug,
        linkedinUrl: c.url,
        status: 'queued' as const,
        nextActionAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ slug: leads.slug });
  const insertedKeys = new Set(inserted.map((row) => row.slug.toLowerCase()));
  for (const c of fresh) {
    if (!insertedKeys.has(c.slug.toLowerCase())) duplicates.push(c.slug);
  }

  return { added: inserted.length, duplicates, invalid };
}
