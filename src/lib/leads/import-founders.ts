import { z } from 'zod';
import type { Db } from '@/db/types';
import { FOUNDER_RECORD_LIMITS as L, MAX_JOBS_PER_COMPANY, type UploadedLeadContext } from '@/lib/import/scraper-files';
import { addNewLeads, type LeadCandidate } from './import';
import { parseLinkedInProfileUrl } from './url';

/** The most founder records one call takes. The browser sends fewer, to stay under the action body limit. */
export const MAX_FOUNDERS_PER_IMPORT = 100;

export type FounderImportResult = {
  added: number;
  /** The slugs that were already leads, or appeared twice in the call. */
  duplicates: string[];
  invalid: { name: string; error: string }[];
};

const text = (max: number) => z.string().max(max);
const textOrNull = (max: number) => z.string().max(max).nullable();

const jobSchema = z.strictObject({
  title: text(L.jobTitle),
  category: textOrNull(L.jobCategory),
  location: textOrNull(L.jobLocation),
  remote: textOrNull(L.jobRemote),
  salary: textOrNull(L.jobSalary),
  equity: textOrNull(L.jobEquity),
  url: textOrNull(L.jobUrl),
  description: text(L.jobDescription),
});

const contextSchema = z.strictObject({
  founder: z.strictObject({
    name: text(L.founderName),
    bio: textOrNull(L.founderBio),
    pastCompanies: textOrNull(L.pastCompanies),
  }),
  company: z.strictObject({
    name: text(L.companyName),
    batch: textOrNull(L.batch),
    website: textOrNull(L.website),
    oneLiner: textOrNull(L.oneLiner),
    description: textOrNull(L.companyDescription),
    // Required, though a stored `LeadContext` can lack it: a page loaded before the upload kept this text
    // must not add founders without it, because the next upload skips them as already imported.
    hiringDescription: textOrNull(L.hiringDescription),
    teamSize: z.number().int().min(0).max(L.teamSize).nullable(),
    jobs: z.array(jobSchema).max(MAX_JOBS_PER_COMPANY),
  }),
}) satisfies z.ZodType<UploadedLeadContext>;

const recordsSchema = z
  .array(z.strictObject({ linkedinUrl: text(L.linkedinUrl), context: contextSchema }))
  .max(MAX_FOUNDERS_PER_IMPORT);

/** `first_name` is the first word of the founder's name, `last_name` the rest; the profile fetch overwrites both. */
function splitName(name: string): { firstName: string | null; lastName: string | null } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { firstName: null, lastName: null };
  const [first, ...rest] = words;
  return { firstName: first, lastName: rest.length > 0 ? rest.join(' ') : null };
}

/**
 * Adds uploaded founders as queued leads whose drafts are pending (spec §5). `records` comes from the
 * browser: a payload that is not a bounded list of founder records throws, and nothing is added.
 */
export async function importFounders(db: Db, records: unknown, now: Date): Promise<FounderImportResult> {
  const parsedRecords = recordsSchema.parse(records);
  const invalid: FounderImportResult['invalid'] = [];
  const candidates: LeadCandidate[] = [];

  for (const record of parsedRecords) {
    const parsed = parseLinkedInProfileUrl(record.linkedinUrl);
    if (!parsed.ok) {
      invalid.push({ name: record.context.founder.name, error: parsed.error });
      continue;
    }
    candidates.push({
      slug: parsed.slug,
      url: parsed.url,
      values: {
        status: 'queued',
        nextActionAt: now,
        ...splitName(record.context.founder.name),
        context: record.context,
        draftStatus: 'pending',
      },
    });
  }

  const { added, duplicates } = await addNewLeads(db, candidates);
  return { added, duplicates, invalid };
}
