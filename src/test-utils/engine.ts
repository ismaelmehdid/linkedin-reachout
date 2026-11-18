import { asc, eq } from 'drizzle-orm';
import { events, leads, type EventRow, type EventType, type Lead, type NewLead } from '@/db/schema';
import type { Db } from '@/db/types';
import type { EngineDeps } from '@/lib/engine/deps';
import { setRunning } from '@/lib/engine/state';
import { saveSettings } from '@/lib/settings/repo';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings/settings';
import { createDryRunClient } from '@/lib/unipile/dry-run';
import { createTestDb } from './db';
import { createFakeUnipile, type FakeUnipile } from './fake-unipile';

/**
 * The active window of the engine tests: Paris working hours, Monday to Friday. It is fixed here, apart
 * from the app's default, so that changing the default hours changes no test.
 */
export const TEST_WINDOW: Settings['window'] = { days: [1, 2, 3, 4, 5], start: '08:30', end: '19:00', timezone: 'Europe/Paris' };

/** A Tuesday, 10:00 in Paris: inside TEST_WINDOW. */
export const NOW = new Date('2026-11-17T09:00:00Z');

/** One hour before NOW, so a seeded lead is due. */
const SEEDED_NEXT_ACTION_AT = new Date('2026-11-17T08:00:00Z');

const TEST_TEMPLATES: Settings['templates'] = {
  inviteNote: 'Hi {{first_name}} from {{company}}',
  firstMessage: 'Thanks {{first_name}}',
  followup1: 'Bump {{first_name}}',
  followup2: 'Last {{first_name}}',
};

export type TestEngine = {
  db: Db;
  fake: FakeUnipile;
  deps: EngineDeps;
  settings: Settings;
  setNow(d: Date): void;
  /** Every `deps.sleep` duration, in ms, in call order. */
  sleeps: number[];
};

/** Spacing off: every send follows the tick, as before spacing existed. A test that needs spacing turns it on. */
const NO_PACING: Settings['pacing'] = { minGapMinutes: 0, maxGapMinutes: 0, dayStartJitterMinutes: 0, followupJitterMinutes: 0 };

/**
 * A fresh database with saved settings (test templates and TEST_WINDOW over the defaults, spacing off) and the engine running,
 * a fake Unipile, a settable clock (NOW by default) and a fixed random value (0.5 by default).
 */
export async function createTestEngine(
  opts: {
    now?: Date;
    random?: number;
    dryRun?: boolean;
    templates?: Partial<Settings['templates']>;
    settings?: (s: Settings) => Settings;
  } = {},
): Promise<TestEngine> {
  const db = await createTestDb();
  const fake = createFakeUnipile();

  // A deep copy, so a callback that edits it in place cannot change DEFAULT_SETTINGS.
  const base: Settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    templates: { ...TEST_TEMPLATES, ...opts.templates },
    pacing: { ...NO_PACING },
    window: structuredClone(TEST_WINDOW),
  };
  const saved = await saveSettings(db, opts.settings ? opts.settings(base) : base);
  if (!saved.ok) throw new Error(`Invalid test settings: ${saved.errors.join('; ')}`);
  await setRunning(db, true);

  let now = opts.now ?? NOW;
  const random = opts.random ?? 0.5;
  const dryRun = opts.dryRun ?? false;
  const sleeps: number[] = [];
  const deps: EngineDeps = {
    db,
    unipile: dryRun ? createDryRunClient(fake) : fake,
    now: () => new Date(now.getTime()),
    random: () => random,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    dryRun,
  };

  return {
    db,
    fake,
    deps,
    settings: saved.settings,
    setNow: (d) => {
      now = d;
    },
    sleeps,
  };
}

let seededLeads = 0;

/** Inserts a due `queued` lead with slug `lead-<n>`; `patch` overrides any column. */
export async function seedLead(db: Db, patch: Partial<NewLead> = {}): Promise<Lead> {
  seededLeads += 1;
  const slug = patch.slug ?? `lead-${seededLeads}`;
  const [lead] = await db
    .insert(leads)
    .values({
      linkedinUrl: `https://www.linkedin.com/in/${encodeURIComponent(slug)}`,
      status: 'queued',
      nextActionAt: SEEDED_NEXT_ACTION_AT,
      ...patch,
      slug,
    })
    .returning();
  return lead;
}

export async function seedEvents(db: Db, type: EventType, count: number, at: Date): Promise<void> {
  if (count === 0) return;
  await db.insert(events).values(Array.from({ length: count }, () => ({ type, createdAt: at })));
}

export async function getLead(db: Db, id: number): Promise<Lead> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead) throw new Error(`No lead with id ${id}`);
  return lead;
}

export async function listEvents(db: Db): Promise<EventRow[]> {
  return db.select().from(events).orderBy(asc(events.id));
}
