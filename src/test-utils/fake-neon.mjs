/**
 * A stand-in for Neon's SQL-over-HTTP endpoint, for tests that run a script as a child process:
 *
 *   node --import ./src/test-utils/fake-neon.mjs scripts/migrate.mjs
 *
 * It replaces the fetch function of the Neon driver in that process and answers from a real Postgres
 * engine, a local PGlite database stored in the folder named by FAKE_NEON_DATA_DIR. The folder is kept
 * between runs, so two runs of a script see the same database.
 *
 * It follows the driver's protocol (see `neon()` in @neondatabase/serverless): one query is
 * `{ query, params }`, a transaction is `{ queries: [...] }` and answers `{ results: [...] }`, rows are
 * arrays of text, and a database error is HTTP 400 with the Postgres error fields.
 */
import { PGlite } from '@electric-sql/pglite';
import { neonConfig } from '@neondatabase/serverless';

const dataDir = process.env.FAKE_NEON_DATA_DIR;
if (!dataDir) throw new Error('FAKE_NEON_DATA_DIR must name the folder of the local test database');

/** An open PGlite keeps the process alive, so the database is closed once the script stops asking. */
const IDLE_MS = 250;

let db;
let closing = Promise.resolve();
let idleTimer;
let running = 0;

async function withDatabase(work) {
  clearTimeout(idleTimer);
  running += 1;
  try {
    await closing;
    db ??= new PGlite(dataDir);
    return await work(db);
  } finally {
    running -= 1;
    if (running === 0) {
      idleTimer = setTimeout(() => {
        const open = db;
        db = undefined;
        closing = open ? open.close() : Promise.resolve();
      }, IDLE_MS);
    }
  }
}

/** A PGlite result in the shape of Neon's raw text output. */
const toNeonResult = (result) => ({
  fields: result.fields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })),
  rows: result.rows.map((row) => row.map((value) => (value === null ? null : String(value)))),
  rowCount: result.affectedRows ?? result.rows.length,
  rowAsArray: true,
});

const run = (executor, { query, params }) => executor.query(query, params, { rowMode: 'array' });

neonConfig.fetchFunction = async (_endpoint, init) => {
  const body = JSON.parse(init.body);
  try {
    if (Array.isArray(body.queries)) {
      const results = await withDatabase((database) =>
        database.transaction(async (tx) => {
          const collected = [];
          for (const query of body.queries) collected.push(toNeonResult(await run(tx, query)));
          return collected;
        }),
      );
      return Response.json({ results });
    }
    return Response.json(toNeonResult(await withDatabase((database) => run(database, body))));
  } catch (error) {
    return Response.json({ message: error.message, code: error.code, severity: 'ERROR' }, { status: 400 });
  }
};
