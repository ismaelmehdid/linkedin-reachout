/**
 * Applies the migrations in ./drizzle to the Neon database named by DATABASE_URL, then says what the
 * database holds.
 *
 * It goes over HTTPS with the driver the app itself uses. `drizzle-kit migrate` goes through a websocket
 * instead and hides its errors: when it cannot connect it exits with code 1 and prints nothing, and on the
 * first real run it ended without an error and without its success line.
 *
 * Each migration runs in one transaction together with its own record, so it is applied completely or not
 * at all, and a run that failed can simply be run again. drizzle-orm's migrator for this driver records
 * nothing until every pending migration has run, so after a failure its next run trips over what is
 * already there. The bookkeeping table and the rule for what is pending are drizzle's, so both agree.
 *
 * Inside a Vercel build it migrates only for a production deployment: preview deployments get the
 * production DATABASE_URL. The build command in vercel.json runs it with --if-production-deploy after
 * every build.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const DEPLOY_OPTION = '--if-production-deploy';
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

const url = process.env.DATABASE_URL?.trim() ?? '';
/** Set by Vercel in every build: `production`, `preview` or `development`. Empty anywhere else. */
const vercelEnv = process.env.VERCEL_ENV?.trim() ?? '';
const options = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * The error and what caused it on one line. The driver keeps a network error in `sourceError`, not in
 * `cause`. Connection strings are removed: they hold the password.
 */
function describe(error) {
  const parts = [];
  for (let current = error; current instanceof Error && parts.length < 4; current = current.cause ?? current.sourceError) {
    // A failed connection to several addresses is an AggregateError: its own message is empty.
    const inner = Array.isArray(current.errors) ? current.errors.map((each) => each?.message).filter(Boolean) : [];
    const message = current.message || [...new Set(inner)].join(', ') || current.name;
    if (parts.some((part) => part.includes(message))) continue;
    parts.push(typeof current.code === 'string' && !message.includes(current.code) ? `${message} (${current.code})` : message);
  }
  const text = parts.length > 0 ? parts.join(': ') : String(error);
  return text.replaceAll(url, '<DATABASE_URL>').replace(/postgres(ql)?:\/\/\S+/gi, '<DATABASE_URL>');
}

// A mistyped option must stop the run instead of being ignored.
const unknown = options.filter((option) => option !== DEPLOY_OPTION);
if (unknown.length > 0) {
  fail(`Unknown option: ${unknown.join(' ')}. The only option is ${DEPLOY_OPTION}.`);
}

// Only a production deployment may migrate. This does not depend on the option, so a build command that
// loses the option still cannot migrate the production database from a preview.
if (vercelEnv !== '' && vercelEnv !== 'production') {
  console.log(`Migrations skipped: not a production deployment (VERCEL_ENV is ${vercelEnv}).`);
  process.exit(0);
}

// The option says "this is the Vercel build". Without VERCEL_ENV the kind of deployment is unknown, and
// skipping here would let a production deployment go live without its migrations.
if (options.includes(DEPLOY_OPTION) && vercelEnv === '') {
  fail(
    'VERCEL_ENV is not set, so this build cannot tell a production deployment from a preview. In Vercel, turn on ' +
      '"Automatically expose System Environment Variables" (Settings, Environment Variables), then redeploy.',
  );
}

if (url === '') {
  fail(
    vercelEnv === ''
      ? "DATABASE_URL is not set. Run: DATABASE_URL='<neon url>' npm run db:migrate"
      : 'DATABASE_URL is not set for this deployment. In Vercel, add Neon to the project (it sets DATABASE_URL), then redeploy.',
  );
}
if (url.startsWith('pglite:')) {
  fail('DATABASE_URL names a local pglite database. That one migrates itself when the app opens it. This command is for Neon.');
}

/** The migration being applied, for the error message. */
let applying = '';

try {
  const client = neon(url);
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const tags = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')).entries.map((entry) => entry.tag);

  await client`create schema if not exists drizzle`;
  await client`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
  const [last] = await client`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
  const lastMillis = last === undefined ? Number.NEGATIVE_INFINITY : Number(last.created_at);

  let applied = 0;
  for (const [index, migration] of migrations.entries()) {
    if (migration.folderMillis <= lastMillis) continue;
    applying = tags[index];
    await client.transaction([
      ...migration.sql.filter((statement) => statement.trim() !== '').map((statement) => client.query(statement)),
      client.query('insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)', [
        migration.hash,
        migration.folderMillis,
      ]),
    ]);
    applied += 1;
  }
  applying = '';

  const [{ count }] = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
  const tables = await client`select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
  console.log(`Migrations applied. New: ${applied}. Recorded: ${count}. Tables: ${tables.map((row) => row.table_name).join(', ')}.`);
} catch (error) {
  fail(`Migration failed${applying === '' ? '' : ` in ${applying}`}: ${describe(error)}`);
}
