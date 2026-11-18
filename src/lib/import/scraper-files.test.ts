import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOB_DESCRIPTION_MAX_LENGTH, MAX_JOBS_PER_COMPANY, parseScraperFiles, type FounderRecord } from './scraper-files';

type JsonJob = Record<string, unknown>;

const jsonJob = (patch: JsonJob = {}): JsonJob => ({
  id: '1',
  title: 'Founding Engineer',
  description: 'Build the product.',
  url: 'https://www.workatastartup.com/jobs/1',
  locations: ['San Francisco, CA, US', 'Remote'],
  remote: 'no',
  min_experience: 1,
  salary: '$150K - $200K',
  equity: '0.5% - 1%',
  category: 'founding_engineer',
  matches_filters: true,
  ...patch,
});

const jsonCompany = (patch: Record<string, unknown> = {}) => ({
  name: 'Acme',
  slug: 'acme',
  batch: 'F26',
  website: 'https://acme.dev',
  url: 'https://www.workatastartup.com/companies/acme',
  one_liner: 'Rockets for everyone',
  description: 'Acme builds rockets.',
  hiring_description: 'We hire builders.',
  team_size: 4,
  founders: [
    { name: 'Jane Doe', linkedin: 'https://linkedin.com/in/jane-doe', bio: 'CEO.', past_companies: 'Stripe' },
  ],
  jobs: [jsonJob()],
  ...patch,
});

const companiesFile = (companies: Record<string, unknown>) => ({
  name: 'companies.json',
  text: JSON.stringify({ companies, last_run: '2026-11-17' }),
});

const FOUNDERS_HEADER =
  'company,batch,website,one_liner,description,hiring_description,company_url,founder_name,linkedin,founder_bio,past_companies,matching_jobs';
const JOBS_HEADER = 'company,website,job_title,category,location,remote,min_experience,salary,equity,job_url,description';

const foundersFile = (...lines: string[]) => ({ name: 'founders.csv', text: [FOUNDERS_HEADER, ...lines].join('\r\n') + '\r\n' });
const jobsFile = (...lines: string[]) => ({ name: 'jobs.csv', text: [JOBS_HEADER, ...lines].join('\r\n') + '\r\n' });

const ACME_FOUNDER_ROW =
  'Acme,F26,https://acme.dev,Rockets for everyone,Acme builds rockets.,We hire builders.,https://www.workatastartup.com/companies/acme,Jane Doe,https://linkedin.com/in/jane-doe,CEO.,Stripe,1';
const ACME_JOB_ROW =
  'Acme,https://acme.dev,Founding Engineer,founding_engineer,"San Francisco, CA, US; Remote",no,1,$150K - $200K,0.5% - 1%,https://www.workatastartup.com/jobs/1,Build the product.';

const ACME_JOB = {
  title: 'Founding Engineer',
  category: 'founding_engineer',
  location: 'San Francisco, CA, US; Remote',
  remote: 'no',
  salary: '$150K - $200K',
  equity: '0.5% - 1%',
  url: 'https://www.workatastartup.com/jobs/1',
  description: 'Build the product.',
};

const JANE: FounderRecord = {
  linkedinUrl: 'https://linkedin.com/in/jane-doe',
  context: {
    founder: { name: 'Jane Doe', bio: 'CEO.', pastCompanies: 'Stripe' },
    company: {
      name: 'Acme',
      batch: 'F26',
      website: 'https://acme.dev',
      oneLiner: 'Rockets for everyone',
      description: 'Acme builds rockets.',
      teamSize: 4,
      jobs: [ACME_JOB],
    },
  },
};

describe('parseScraperFiles', () => {
  it('reads founders, their company and its coding jobs from companies.json', () => {
    expect(parseScraperFiles([companiesFile({ acme: jsonCompany() })])).toEqual({
      records: [JANE],
      skippedNoLinkedIn: 0,
      errors: [],
    });
  });

  it('reads the same record from founders.csv and jobs.csv, without a team size', () => {
    expect(parseScraperFiles([foundersFile(ACME_FOUNDER_ROW), jobsFile(ACME_JOB_ROW)])).toEqual({
      records: [{ ...JANE, context: { ...JANE.context, company: { ...JANE.context.company, teamSize: null } } }],
      skippedNoLinkedIn: 0,
      errors: [],
    });
  });

  it('recognises files by their content, not their name', () => {
    const result = parseScraperFiles([
      { name: 'a.txt', text: jobsFile(ACME_JOB_ROW).text },
      { name: 'b.txt', text: foundersFile(ACME_FOUNDER_ROW).text },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.records.map((r) => r.context.company.jobs)).toEqual([[ACME_JOB]]);
  });

  it('keeps only coding jobs, and from companies.json only those that match the filters', () => {
    const company = jsonCompany({
      jobs: [
        jsonJob({ title: 'Backend', category: 'backend' }),
        jsonJob({ title: 'Designer', category: 'non_coding' }),
        jsonJob({ title: 'Frontend', category: 'frontend' }),
        jsonJob({ title: 'No category', category: null }),
        jsonJob({ title: 'Filtered out', category: 'fullstack', matches_filters: false }),
        jsonJob({ title: 'Filter as text', category: 'fullstack', matches_filters: 'True' }),
        jsonJob({ title: 'Staff', category: 'member_of_technical_staff' }),
      ],
    });
    const [record] = parseScraperFiles([companiesFile({ acme: company })]).records;
    expect(record.context.company.jobs.map((j) => j.title)).toEqual(['Backend', 'Staff']);

    const csv = parseScraperFiles([
      foundersFile(ACME_FOUNDER_ROW),
      jobsFile(
        'Acme,,Data,data_engineering,,,,,,,',
        'Acme,,ML,data_science_ml,,,,,,,',
        'Acme,,Security,security,,,,,,,',
        'Acme,,Infra,infra_devops,,,,,,,',
      ),
    ]);
    expect(csv.records[0].context.company.jobs.map((j) => j.title)).toEqual(['Data', 'Infra']);
  });

  it('keeps a company with no coding job, with no jobs', () => {
    const [record] = parseScraperFiles([
      companiesFile({ acme: jsonCompany({ jobs: [jsonJob({ category: 'non_coding' })] }) }),
    ]).records;
    expect(record.context.company.jobs).toEqual([]);
  });

  it('joins CSV jobs to founders on the exact company name', () => {
    const result = parseScraperFiles([
      foundersFile(ACME_FOUNDER_ROW),
      jobsFile(ACME_JOB_ROW, ACME_JOB_ROW.replace(/^Acme,/, 'acme,'), ACME_JOB_ROW.replace(/^Acme,/, 'Acme Inc,')),
    ]);
    expect(result.records[0].context.company.jobs).toEqual([ACME_JOB]);
  });

  it('cuts each job description to its first characters', () => {
    const long = 'x'.repeat(JOB_DESCRIPTION_MAX_LENGTH + 500);
    const [record] = parseScraperFiles([
      companiesFile({ acme: jsonCompany({ jobs: [jsonJob({ description: long })] }) }),
    ]).records;
    expect(record.context.company.jobs[0].description).toBe('x'.repeat(JOB_DESCRIPTION_MAX_LENGTH));
  });

  it('keeps at most the job limit per company', () => {
    const jobs = Array.from({ length: MAX_JOBS_PER_COMPANY + 5 }, (_, i) => jsonJob({ title: `Job ${i}` }));
    const [record] = parseScraperFiles([companiesFile({ acme: jsonCompany({ jobs }) })]).records;
    expect(record.context.company.jobs).toHaveLength(MAX_JOBS_PER_COMPANY);
  });

  it('turns empty strings into null and the team size into a number or null', () => {
    const company = jsonCompany({
      batch: '',
      website: '',
      one_liner: '',
      description: '',
      team_size: '12',
      founders: [{ name: 'Jane Doe', linkedin: 'https://linkedin.com/in/jane-doe', bio: '', past_companies: '' }],
      jobs: [jsonJob({ locations: [], remote: '', salary: '', equity: '', url: '' })],
    });
    const other = jsonCompany({
      name: 'Other',
      team_size: 'a few',
      founders: [{ name: 'John Roe', linkedin: 'https://linkedin.com/in/john-roe', bio: 'CTO.', past_companies: '' }],
    });
    const { records } = parseScraperFiles([companiesFile({ acme: company, other })]);
    expect(records[0].context).toEqual({
      founder: { name: 'Jane Doe', bio: null, pastCompanies: null },
      company: {
        name: 'Acme',
        batch: null,
        website: null,
        oneLiner: null,
        description: null,
        teamSize: 12,
        jobs: [
          {
            title: 'Founding Engineer',
            category: 'founding_engineer',
            location: null,
            remote: null,
            salary: null,
            equity: null,
            url: null,
            description: 'Build the product.',
          },
        ],
      },
    });
    expect(records[1].context.company.teamSize).toBeNull();
  });

  it('counts founders with no LinkedIn URL instead of making records of them', () => {
    const company = jsonCompany({
      founders: [
        { name: 'Jane Doe', linkedin: 'https://linkedin.com/in/jane-doe', bio: '', past_companies: '' },
        { name: 'No Profile', linkedin: '', bio: '', past_companies: '' },
        { name: 'Blank Profile', linkedin: '  ', bio: '', past_companies: '' },
      ],
    });
    const result = parseScraperFiles([companiesFile({ acme: company })]);
    expect(result.records.map((r) => r.context.founder.name)).toEqual(['Jane Doe']);
    expect(result.skippedNoLinkedIn).toBe(2);
  });

  it('lets companies.json win over the CSVs for a company it holds, and makes one record per founder', () => {
    const csvOnlyFounder =
      'Beta,W26,https://beta.dev,,Beta does things.,,,John Roe,https://linkedin.com/in/john-roe,CTO.,,0';
    const result = parseScraperFiles([
      foundersFile(ACME_FOUNDER_ROW.replace('Acme builds rockets.', 'Old description.'), csvOnlyFounder),
      jobsFile(ACME_JOB_ROW.replace('Founding Engineer,', 'Old job,'), 'Beta,,Backend,backend,,,,,,,Beta job.'),
      companiesFile({ acme: jsonCompany() }),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.records).toEqual([
      JANE,
      {
        linkedinUrl: 'https://linkedin.com/in/john-roe',
        context: {
          founder: { name: 'John Roe', bio: 'CTO.', pastCompanies: null },
          company: {
            name: 'Beta',
            batch: 'W26',
            website: 'https://beta.dev',
            oneLiner: null,
            description: 'Beta does things.',
            teamSize: null,
            jobs: [
              {
                title: 'Backend',
                category: 'backend',
                location: null,
                remote: null,
                salary: null,
                equity: null,
                url: null,
                description: 'Beta job.',
              },
            ],
          },
        },
      },
    ]);
  });

  it('makes one record of a founder listed twice', () => {
    const company = jsonCompany({
      founders: [
        { name: 'Jane Doe', linkedin: 'https://linkedin.com/in/jane-doe', bio: 'CEO.', past_companies: 'Stripe' },
        { name: 'Jane Doe', linkedin: 'https://linkedin.com/in/jane-doe', bio: 'CEO.', past_companies: 'Stripe' },
      ],
    });
    expect(parseScraperFiles([companiesFile({ acme: company })]).records).toEqual([JANE]);
  });

  it('names a file it does not recognise', () => {
    const result = parseScraperFiles([
      { name: 'notes.txt', text: 'hello' },
      { name: 'other.json', text: '{"leads": []}' },
      { name: 'broken.json', text: '{"companies": ' },
      { name: 'people.csv', text: 'name,url\nJane,x\n' },
      companiesFile({ acme: jsonCompany() }),
    ]);
    expect(result.records).toEqual([JANE]);
    expect(result.errors).toEqual([
      'notes.txt: not a companies.json, founders.csv or jobs.csv file',
      'other.json: not a companies.json, founders.csv or jobs.csv file',
      'broken.json: not a companies.json, founders.csv or jobs.csv file',
      'people.csv: not a companies.json, founders.csv or jobs.csv file',
    ]);
  });

  it('names a CSV file that cannot be parsed or lacks a needed column', () => {
    const result = parseScraperFiles([
      { name: 'founders.csv', text: 'founder_name,company\n"Jane,Acme\n' },
      { name: 'jobs.csv', text: 'job_title,company\nEngineer,Acme\n' },
    ]);
    expect(result.records).toEqual([]);
    expect(result.errors).toEqual([
      'founders.csv: unterminated quoted field',
      'jobs.csv: missing column category',
    ]);
  });

  it('says when jobs come without founders, and founders without jobs', () => {
    expect(parseScraperFiles([jobsFile(ACME_JOB_ROW)]).errors).toEqual([
      'No founders to import: add companies.json or founders.csv',
    ]);
    expect(parseScraperFiles([foundersFile(ACME_FOUNDER_ROW)]).errors).toEqual([
      'founders.csv came without jobs.csv: its founders get no jobs',
    ]);
    expect(parseScraperFiles([foundersFile(ACME_FOUNDER_ROW), companiesFile({ acme: jsonCompany() })]).errors).toEqual([]);
  });
});

const SAMPLE_DIR = '/Users/ismaelmehdid/Desktop/scrapper/data';
const SAMPLE_JSON = path.join(SAMPLE_DIR, 'companies.json');
const SAMPLE_FOUNDERS = path.join(SAMPLE_DIR, 'founders.csv');
const SAMPLE_JOBS = path.join(SAMPLE_DIR, 'jobs.csv');
const hasSamples = existsSync(SAMPLE_JSON) && existsSync(SAMPLE_FOUNDERS) && existsSync(SAMPLE_JOBS);

describe.skipIf(!hasSamples)('parseScraperFiles on the real sample files', () => {
  const read = (file: string) => ({ name: path.basename(file), text: readFileSync(file, 'utf8') });

  it('finds 265 founders, 264 with a LinkedIn URL, in 136 companies, the same from either source', () => {
    const fromJson = parseScraperFiles([read(SAMPLE_JSON)]);
    const fromCsv = parseScraperFiles([read(SAMPLE_FOUNDERS), read(SAMPLE_JOBS)]);
    const fromAll = parseScraperFiles([read(SAMPLE_JOBS), read(SAMPLE_JSON), read(SAMPLE_FOUNDERS)]);

    for (const result of [fromJson, fromCsv, fromAll]) {
      expect(result.errors).toEqual([]);
      expect(result.records).toHaveLength(264);
      expect(result.skippedNoLinkedIn).toBe(1);
      expect(new Set(result.records.map((r) => r.context.company.name)).size).toBe(136);
    }

    const jobsByFounder = (result: typeof fromJson) =>
      new Map(result.records.map((r) => [r.linkedinUrl, r.context.company.jobs]));
    const csvJobs = jobsByFounder(fromCsv);
    for (const [url, jobs] of jobsByFounder(fromJson)) expect(csvJobs.get(url)).toEqual(jobs);
    expect(fromJson.records.some((r) => r.context.company.jobs.length > 0)).toBe(true);
    expect(fromAll.records).toEqual(fromJson.records);
  });
});
