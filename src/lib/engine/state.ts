import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { appStateTable } from '@/db/schema';
import type { Db } from '@/db/types';

export type AppState = typeof appStateTable.$inferSelect;

export const ERROR_STREAK_LIMIT = 3;

const APP_STATE_ID = 1;

const isAppStateRow = eq(appStateTable.id, APP_STATE_ID);

/** Creates the single app-state row with its column defaults when it is missing. Idempotent. */
async function ensureAppStateRow(db: Db): Promise<void> {
  await db.insert(appStateTable).values({ id: APP_STATE_ID }).onConflictDoNothing();
}

export async function getAppState(db: Db): Promise<AppState> {
  const read = () => db.select().from(appStateTable).where(isAppStateRow);
  const [existing] = await read();
  if (existing) return existing;
  await ensureAppStateRow(db);
  const [created] = await read();
  return created;
}

/** One upsert, so it also works before the row exists. */
export async function updateAppState(db: Db, patch: Partial<Omit<AppState, 'id'>>): Promise<void> {
  if (Object.values(patch).every((value) => value === undefined)) {
    await ensureAppStateRow(db);
    return;
  }
  await db
    .insert(appStateTable)
    .values({ ...patch, id: APP_STATE_ID })
    .onConflictDoUpdate({ target: appStateTable.id, set: patch });
}

/** A small read of a real table: it fails when the database is down, suspended or not migrated. */
export async function pingDatabase(db: Db): Promise<void> {
  await db.select({ id: appStateTable.id }).from(appStateTable).limit(1);
}

/** When a lease taken at `now` runs out. It also names the lease: `releaseTickLock` frees only this one. */
export function tickLeaseEnd(now: Date, leaseMs: number): Date {
  return new Date(now.getTime() + leaseMs);
}

/**
 * Takes the tick lease with one conditional update, so two ticks can never both get it.
 * An expired lease (a crashed tick) is taken over.
 */
export async function acquireTickLock(db: Db, now: Date, leaseMs: number): Promise<boolean> {
  await ensureAppStateRow(db);
  const taken = await db
    .update(appStateTable)
    .set({ tickLockUntil: tickLeaseEnd(now, leaseMs) })
    .where(and(isAppStateRow, or(isNull(appStateTable.tickLockUntil), lt(appStateTable.tickLockUntil, now))))
    .returning({ id: appStateTable.id });
  return taken.length > 0;
}

/**
 * Releases the lease that ends at `leaseUntil`, and only that one: a tick that outlived its lease must
 * not free the lock that another tick has taken since.
 */
export async function releaseTickLock(db: Db, leaseUntil: Date): Promise<void> {
  await db
    .update(appStateTable)
    .set({ tickLockUntil: null })
    .where(and(isAppStateRow, eq(appStateTable.tickLockUntil, leaseUntil)));
}

/** Starting clears the auto-pause reason and the error streak. */
export async function setRunning(db: Db, running: boolean): Promise<void> {
  await updateAppState(db, running ? { running: true, pauseReason: null, consecutiveErrors: 0 } : { running: false });
}

/** Stops all sending and shows `reason` on the dashboard. Pressing Start clears it. */
export async function pauseApp(db: Db, reason: string): Promise<void> {
  await updateAppState(db, { running: false, pauseReason: reason });
}

/**
 * Unipile refused the account itself, so every lead would fail the same way: stop at once.
 * `detail` is the error type, or `http_<status>` when the error has none.
 */
export function pauseForAccountError(db: Db, detail: string): Promise<void> {
  return pauseApp(db, `Auto-paused: Unipile rejected the account (${detail}). Reconnect the LinkedIn account in Unipile, then press Start.`);
}

/**
 * Counts one more limit, 5xx or network error. When the streak reaches the limit, the same
 * statement stops all sending and records why.
 */
export async function incrementErrorStreak(db: Db, reason: string): Promise<{ autoPaused: boolean }> {
  await ensureAppStateRow(db);
  const pauseReason = `Auto-paused after ${ERROR_STREAK_LIMIT} Unipile errors in a row (last: ${reason})`;
  // In SET, every column reference reads the row as it was before this update.
  const reachesLimit = sql`${appStateTable.consecutiveErrors} + 1 >= ${ERROR_STREAK_LIMIT}`;
  const [row] = await db
    .update(appStateTable)
    .set({
      consecutiveErrors: sql`${appStateTable.consecutiveErrors} + 1`,
      running: sql`case when ${reachesLimit} then false else ${appStateTable.running} end`,
      pauseReason: sql`case when ${reachesLimit} then ${pauseReason} else ${appStateTable.pauseReason} end`,
    })
    .where(isAppStateRow)
    .returning({ consecutiveErrors: appStateTable.consecutiveErrors });
  return { autoPaused: row.consecutiveErrors >= ERROR_STREAK_LIMIT };
}

export async function resetErrorStreak(db: Db): Promise<void> {
  await updateAppState(db, { consecutiveErrors: 0 });
}
