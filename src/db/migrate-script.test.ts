import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/migrate.mjs');
const FAKE_NEON = path.join(ROOT, 'src/test-utils/fake-neon.mjs');

/** A database that answers nothing: a run that reaches it fails with "Migration failed". */
const UNREACHABLE = 'postgresql://user:hunter2-secret@localhost/neondb';

type Outcome = { code: number; stdout: string; stderr: string };
type Options = { args?: string[]; vercelEnv?: string; script?: string; fakeNeonDataDir?: string };

/**
 * Runs the migration script with only the given `DATABASE_URL`, options and `VERCEL_ENV`. With
 * `fakeNeonDataDir`, the Neon driver in that process talks to a local Postgres engine in that folder.
 */
function runScript(databaseUrl?: string, { args = [], vercelEnv, script = SCRIPT, fakeNeonDataDir }: Options = {}): Promise<Outcome> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  delete env.VERCEL_ENV;
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
  if (vercelEnv !== undefined) env.VERCEL_ENV = vercelEnv;
  if (fakeNeonDataDir !== undefined) env.FAKE_NEON_DATA_DIR = fakeNeonDataDir;
  const nodeArgs = fakeNeonDataDir === undefined ? [script, ...args] : ['--import', FAKE_NEON, script, ...args];
  return new Promise((resolve) => {
    execFile(process.execPath, nodeArgs, { env }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

describe('scripts/migrate.mjs, run by hand', () => {
  it('refuses to run without DATABASE_URL', async () => {
    const outcome = await runScript();

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('DATABASE_URL');
  });

  it('refuses a local pglite database, which migrates itself', async () => {
    const outcome = await runScript('pglite:./.data/dev');

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/pglite/i);
  });

  it('says that it failed, and why, when the database cannot be reached', async () => {
    const outcome = await runScript(UNREACHABLE);

    expect(outcome.code).toBe(1);
    // The driver keeps the network reason apart from its own message; both must be printed.
    expect(outcome.stderr).toMatch(/Migration failed: [\s\S]*fetch failed: \S+/);
  });

  it.each([
    ['a connection string the driver cannot parse', 'postgresql://user:hunter2-secret@host:notaport/db'],
    ['a value that is not a connection string at all', 'hunter2-secret not-a-url'],
  ])('never shows the password when the driver quotes %s', async (_case, databaseUrl) => {
    const outcome = await runScript(databaseUrl);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/Migration failed/);
    expect(outcome.stderr + outcome.stdout).not.toContain('hunter2-secret');
  });

  it('refuses an option it does not know, without reaching the database', async () => {
    const outcome = await runScript(UNREACHABLE, { args: ['--if-production-deplo'], vercelEnv: 'production' });

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('--if-production-deplo');
    expect(outcome.stderr).not.toMatch(/Migration failed/);
  });

  it('never migrates inside a Vercel build that is not a production deployment, even without the option', async () => {
    const outcome = await runScript(UNREACHABLE, { vercelEnv: 'preview' });

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toMatch(/skipped/i);
    expect(outcome.stderr).not.toMatch(/Migration failed/);
  });
});

describe('scripts/migrate.mjs --if-production-deploy, as the Vercel build runs it', () => {
  const args = ['--if-production-deploy'];

  it('skips a preview deployment, without reaching the database', async () => {
    const outcome = await runScript(UNREACHABLE, { args, vercelEnv: 'preview' });

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toMatch(/skipped/i);
    expect(outcome.stderr).not.toMatch(/Migration failed/);
  });

  it('fails when VERCEL_ENV is missing, so that a production build can never skip its migrations in silence', async () => {
    const outcome = await runScript(UNREACHABLE, { args });

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('VERCEL_ENV');
    expect(outcome.stderr).not.toMatch(/Migration failed/);
  });

  it('migrates a production deployment, and fails the build when the migration fails', async () => {
    const outcome = await runScript(UNREACHABLE, { args, vercelEnv: 'production' });

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/Migration failed/);
  });

  it('fails a production build that has no DATABASE_URL, and says what to do in Vercel', async () => {
    const outcome = await runScript(undefined, { args, vercelEnv: 'production' });

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('DATABASE_URL');
    expect(outcome.stderr).toMatch(/redeploy/i);
    expect(outcome.stderr).not.toContain('npm run db:migrate');
  });
});

describe('the build command in vercel.json', () => {
  const buildCommand = (): string =>
    (JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) as { buildCommand: string }).buildCommand;

  /** The `node scripts/migrate.mjs …` part of the build command, as its list of arguments. */
  function migrateArgs(): string[] {
    const step = buildCommand().split('&&').map((part) => part.trim()).find((part) => part.startsWith('node scripts/migrate.mjs'));
    if (step === undefined) throw new Error(`No migration step in the build command: ${buildCommand()}`);
    return step.split(/\s+/).slice(2);
  }

  it('builds first, then migrates', () => {
    const steps = buildCommand().split('&&').map((part) => part.trim());

    expect(steps[0]).toBe('npm run build');
    expect(steps[1]).toMatch(/^node scripts\/migrate\.mjs /);
  });

  it('never migrates from a preview deployment, which shares the production DATABASE_URL', async () => {
    const outcome = await runScript(UNREACHABLE, { args: migrateArgs(), vercelEnv: 'preview' });

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toMatch(/skipped/i);
  });

  it('migrates from a production deployment', async () => {
    const outcome = await runScript(UNREACHABLE, { args: migrateArgs(), vercelEnv: 'production' });

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/Migration failed/);
  });
});

describe('scripts/migrate.mjs against a database', () => {
  const DATABASE_URL = 'postgresql://user:hunter2-secret@test-endpoint.example.neon.tech/neondb';
  const folders: string[] = [];

  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  const tempFolder = (): string => {
    const folder = mkdtempSync(path.join(tmpdir(), 'migrate-script-'));
    folders.push(folder);
    return folder;
  };

  /** What a database folder holds: the recorded migrations and the tables of the app. */
  async function inspect(dataDir: string): Promise<{ recorded: number; tables: string[] }> {
    const db = new PGlite(dataDir);
    try {
      const recorded = await db.query<{ count: number }>('select count(*)::int as count from drizzle.__drizzle_migrations');
      const tables = await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
      );
      return { recorded: recorded.rows[0].count, tables: tables.rows.map((row) => row.table_name) };
    } finally {
      await db.close();
    }
  }

  /**
   * A copy of the script next to its own `drizzle` folder, holding the given migrations, one list of
   * statements each. The script reads `../drizzle` and its packages from where it stands.
   */
  function projectWith(migrations: string[][]): { script: string; setMigrations: (next: string[][]) => void } {
    const project = tempFolder();
    mkdirSync(path.join(project, 'scripts'));
    cpSync(SCRIPT, path.join(project, 'scripts/migrate.mjs'));
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(project, 'node_modules'), 'dir');
    const setMigrations = (next: string[][]): void => {
      rmSync(path.join(project, 'drizzle'), { recursive: true, force: true });
      mkdirSync(path.join(project, 'drizzle/meta'), { recursive: true });
      const entries = next.map((statements, idx) => {
        const tag = `000${idx}_test`;
        writeFileSync(path.join(project, `drizzle/${tag}.sql`), statements.join('--> statement-breakpoint\n'));
        return { idx, version: '7', when: 1_800_000_000_000 + idx, tag, breakpoints: true };
      });
      writeFileSync(path.join(project, 'drizzle/meta/_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }));
    };
    setMigrations(migrations);
    return { script: path.join(project, 'scripts/migrate.mjs'), setMigrations };
  }

  it('applies the migrations of this repository to an empty database, and says what the database holds', async () => {
    const dataDir = tempFolder();

    const outcome = await runScript(DATABASE_URL, { fakeNeonDataDir: dataDir });

    expect(outcome.stderr).toBe('');
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toMatch(/Migrations applied/);
    expect(outcome.stdout).toContain('app_state, events, leads, settings');
    const journal = JSON.parse(readFileSync(path.join(ROOT, 'drizzle/meta/_journal.json'), 'utf8')) as { entries: unknown[] };
    expect(await inspect(dataDir)).toEqual({ recorded: journal.entries.length, tables: ['app_state', 'events', 'leads', 'settings'] });
  });

  it('applies nothing the second time', async () => {
    const dataDir = tempFolder();
    await runScript(DATABASE_URL, { fakeNeonDataDir: dataDir });
    const before = await inspect(dataDir);

    const outcome = await runScript(DATABASE_URL, { fakeNeonDataDir: dataDir });

    expect(outcome.code).toBe(0);
    expect(await inspect(dataDir)).toEqual(before);
  });

  it('applies only the migrations that are newer than the last recorded one', async () => {
    const dataDir = tempFolder();
    const { script, setMigrations } = projectWith([['create table first_table (id int)']]);
    await runScript(DATABASE_URL, { script, fakeNeonDataDir: dataDir });

    setMigrations([['create table first_table (id int)'], ['create table second_table (id int)']]);
    const outcome = await runScript(DATABASE_URL, { script, fakeNeonDataDir: dataDir });

    expect(outcome.code).toBe(0);
    expect(await inspect(dataDir)).toEqual({ recorded: 2, tables: ['first_table', 'second_table'] });
  });

  it('undoes a migration that fails halfway, and keeps the ones before it', async () => {
    const dataDir = tempFolder();
    const { script } = projectWith([
      ['create table first_table (id int)'],
      ['create table second_table (id int)', 'alter table no_such_table add column oops int'],
    ]);

    const outcome = await runScript(DATABASE_URL, { script, fakeNeonDataDir: dataDir });

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/Migration failed/);
    expect(outcome.stderr).toContain('no_such_table');
    expect(await inspect(dataDir)).toEqual({ recorded: 1, tables: ['first_table'] });
  });

  it('runs again without repair once the failing migration is corrected', async () => {
    const dataDir = tempFolder();
    const { script, setMigrations } = projectWith([
      ['create table first_table (id int)'],
      ['create table second_table (id int)', 'alter table no_such_table add column oops int'],
    ]);
    await runScript(DATABASE_URL, { script, fakeNeonDataDir: dataDir });

    setMigrations([
      ['create table first_table (id int)'],
      ['create table second_table (id int)', 'alter table second_table add column fine int'],
    ]);
    const outcome = await runScript(DATABASE_URL, { script, fakeNeonDataDir: dataDir });

    expect(outcome.stderr).toBe('');
    expect(outcome.code).toBe(0);
    expect(await inspect(dataDir)).toEqual({ recorded: 2, tables: ['first_table', 'second_table'] });
  });
});
