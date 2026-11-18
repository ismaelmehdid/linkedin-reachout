import type { LeadContext, LeadContextJob } from '@/db/schema';
import { csvRecords, parseCsv } from './csv';

/**
 * Reads the scraper's files (`companies.json`, or `founders.csv` with `jobs.csv`, or any mix of them) into
 * founder records. Pure: it runs in the browser before the upload, and in the tests.
 */

/** The job categories the scraper counts as coding jobs (the ones it writes to `jobs.csv`). */
export const CODING_JOB_CATEGORIES: readonly string[] = [
  'founding_engineer',
  'fullstack',
  'forward_deployed',
  'product_engineer',
  'ai_engineer',
  'member_of_technical_staff',
  'infra_devops',
  'data_engineering',
  'backend',
];

export const JOB_DESCRIPTION_MAX_LENGTH = 3000;
export const MAX_JOBS_PER_COMPANY = 30;

/**
 * The longest each text of a record may be. The parser cuts every text to it, and the server rejects
 * anything longer, so a record the parser made always passes the server's check.
 */
export const FOUNDER_RECORD_LIMITS = {
  linkedinUrl: 500,
  founderName: 200,
  founderBio: 4000,
  pastCompanies: 2000,
  companyName: 200,
  batch: 50,
  website: 500,
  oneLiner: 500,
  companyDescription: 4000,
  jobTitle: 300,
  jobCategory: 100,
  jobLocation: 1000,
  jobRemote: 50,
  jobSalary: 200,
  jobEquity: 200,
  jobUrl: 500,
  jobDescription: JOB_DESCRIPTION_MAX_LENGTH,
  teamSize: 10_000_000,
} as const;

export type FounderRecord = { linkedinUrl: string; context: LeadContext };

export type ScraperFilesResult = {
  records: FounderRecord[];
  /** Founders whose LinkedIn field is empty: they cannot become leads. */
  skippedNoLinkedIn: number;
  errors: string[];
};

type Founder = { name: string; linkedin: string; bio: string | null; pastCompanies: string | null };
type Company = Omit<LeadContext['company'], 'jobs'> & { jobs: LeadContextJob[]; founders: Founder[] };

const L = FOUNDER_RECORD_LIMITS;
const NOT_RECOGNISED = 'not a companies.json, founders.csv or jobs.csv file';
const FOUNDER_COLUMNS = ['company', 'founder_name', 'linkedin'];
const JOB_COLUMNS = ['company', 'job_title', 'category'];

/** Cuts `value` to `max` characters, without splitting a surrogate pair. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = /[\uD800-\uDBFF]/.test(value[max - 1]) ? max - 1 : max;
  return value.slice(0, end);
}

/** A JSON value as text: strings as they are, numbers and booleans written out, anything else empty. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

const text = (value: unknown, max: number): string => cut(asText(value).trim(), max);
const textOrNull = (value: unknown, max: number): string | null => text(value, max) || null;

function teamSize(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= L.teamSize ? n : null;
}

const isCodingCategory = (category: string) => CODING_JOB_CATEGORIES.includes(category);

function makeJob(fields: {
  title: unknown;
  category: unknown;
  location: unknown;
  remote: unknown;
  salary: unknown;
  equity: unknown;
  url: unknown;
  description: unknown;
}): LeadContextJob {
  return {
    title: text(fields.title, L.jobTitle),
    category: textOrNull(fields.category, L.jobCategory),
    location: textOrNull(fields.location, L.jobLocation),
    remote: textOrNull(fields.remote, L.jobRemote),
    salary: textOrNull(fields.salary, L.jobSalary),
    equity: textOrNull(fields.equity, L.jobEquity),
    url: textOrNull(fields.url, L.jobUrl),
    description: text(fields.description, L.jobDescription),
  };
}

function makeFounder(name: unknown, linkedin: unknown, bio: unknown, pastCompanies: unknown): Founder {
  return {
    name: text(name, L.founderName),
    linkedin: text(linkedin, L.linkedinUrl),
    bio: textOrNull(bio, L.founderBio),
    pastCompanies: textOrNull(pastCompanies, L.pastCompanies),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The companies of a `companies.json`, or null when the text is not one. */
function readCompaniesJson(raw: string): Company[] | null {
  if (!raw.trimStart().replace(/^\uFEFF/, '').startsWith('{')) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!isObject(data) || !isObject(data.companies)) return null;

  return Object.entries(data.companies)
    .filter((entry): entry is [string, Record<string, unknown>] => isObject(entry[1]))
    .map(([slug, c]) => ({
      name: text(c.name, L.companyName) || cut(slug, L.companyName),
      batch: textOrNull(c.batch, L.batch),
      website: textOrNull(c.website, L.website),
      oneLiner: textOrNull(c.one_liner, L.oneLiner),
      description: textOrNull(c.description, L.companyDescription),
      teamSize: teamSize(c.team_size),
      founders: asArray(c.founders)
        .filter(isObject)
        .map((f) => makeFounder(f.name, f.linkedin, f.bio, f.past_companies)),
      jobs: asArray(c.jobs)
        .filter(isObject)
        .filter((j) => j.matches_filters === true && isCodingCategory(asText(j.category).trim()))
        .map((j) =>
          makeJob({
            title: j.title,
            category: j.category,
            // jobs.csv writes the locations list joined with "; ".
            location: Array.isArray(j.locations) ? j.locations.map(asText).filter(Boolean).join('; ') : j.locations,
            remote: j.remote,
            salary: j.salary,
            equity: j.equity,
            url: j.url,
            description: j.description,
          }),
        ),
    }));
}

type CsvFile = { kind: 'founders' | 'jobs'; records: Record<string, string>[] };

/** A founders or jobs CSV, an error message, or null when the text is not one of them. */
function readCsv(raw: string): CsvFile | string | null {
  let parsed: ReturnType<typeof csvRecords>;
  try {
    parsed = csvRecords(parseCsv(raw));
  } catch (error) {
    return error instanceof Error ? error.message : 'unreadable CSV';
  }
  const kind = parsed.header.includes('founder_name') ? 'founders' : parsed.header.includes('job_title') ? 'jobs' : null;
  if (kind === null) return null;
  const missing = (kind === 'founders' ? FOUNDER_COLUMNS : JOB_COLUMNS).filter((c) => !parsed.header.includes(c));
  if (missing.length > 0) return `missing column ${missing.join(', ')}`;
  return { kind, records: parsed.records };
}

export function parseScraperFiles(files: { name: string; text: string }[]): ScraperFilesResult {
  const errors: string[] = [];
  const jsonCompanies: Company[] = [];
  const founderRows: Record<string, string>[] = [];
  const jobRows: Record<string, string>[] = [];
  let readFounderSource = false;
  let readJobsCsv = false;

  for (const file of files) {
    const companies = readCompaniesJson(file.text);
    if (companies) {
      jsonCompanies.push(...companies);
      readFounderSource = true;
      continue;
    }
    const csv = readCsv(file.text);
    if (csv === null) {
      errors.push(`${file.name}: ${NOT_RECOGNISED}`);
    } else if (typeof csv === 'string') {
      errors.push(`${file.name}: ${csv}`);
    } else if (csv.kind === 'founders') {
      founderRows.push(...csv.records);
      readFounderSource = true;
    } else {
      jobRows.push(...csv.records);
      readJobsCsv = true;
    }
  }

  // companies.json wins for every company it holds; the first file to hold a company wins among them.
  const companies = new Map<string, Company>();
  for (const company of jsonCompanies) if (!companies.has(company.name)) companies.set(company.name, company);

  let usedCsvFounders = false;
  const csvCompanies = new Map<string, Company>();
  for (const row of founderRows) {
    const name = text(row.company, L.companyName);
    if (companies.has(name)) continue;
    usedCsvFounders = true;
    let company = csvCompanies.get(name);
    if (!company) {
      company = {
        name,
        batch: textOrNull(row.batch, L.batch),
        website: textOrNull(row.website, L.website),
        oneLiner: textOrNull(row.one_liner, L.oneLiner),
        description: textOrNull(row.description, L.companyDescription),
        teamSize: null,
        founders: [],
        // The join is on the exact company name, the same text the scraper wrote to both files.
        jobs: jobRows
          .filter((job) => job.company === row.company && isCodingCategory(job.category.trim()))
          .map((job) =>
            makeJob({
              title: job.job_title,
              category: job.category,
              location: job.location,
              remote: job.remote,
              salary: job.salary,
              equity: job.equity,
              url: job.job_url,
              description: job.description,
            }),
          ),
      };
      csvCompanies.set(name, company);
    }
    company.founders.push(makeFounder(row.founder_name, row.linkedin, row.founder_bio, row.past_companies));
  }
  for (const [name, company] of csvCompanies) companies.set(name, company);

  if (readJobsCsv && !readFounderSource) errors.push('No founders to import: add companies.json or founders.csv');
  if (usedCsvFounders && !readJobsCsv) errors.push('founders.csv came without jobs.csv: its founders get no jobs');

  const records: FounderRecord[] = [];
  const seen = new Set<string>();
  let skippedNoLinkedIn = 0;
  for (const { founders, jobs, ...company } of companies.values()) {
    for (const founder of founders) {
      if (founder.linkedin === '') {
        skippedNoLinkedIn += 1;
        continue;
      }
      const key = founder.linkedin.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({
        linkedinUrl: founder.linkedin,
        context: {
          founder: { name: founder.name, bio: founder.bio, pastCompanies: founder.pastCompanies },
          company: { ...company, jobs: jobs.slice(0, MAX_JOBS_PER_COMPANY) },
        },
      });
    }
  }

  return { records, skippedNoLinkedIn, errors };
}
