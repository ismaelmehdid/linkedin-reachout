import { eq } from 'drizzle-orm';
import { settingsTable } from '@/db/schema';
import type { Db } from '@/db/types';
import { DEFAULT_SETTINGS, parseSettings, safeParseSettings, validateSettings, type Settings } from './settings';

const SETTINGS_ROW_ID = 1;

export async function getSettings(db: Db): Promise<Settings> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.id, SETTINGS_ROW_ID));
  return row ? parseSettings(row.value) : DEFAULT_SETTINGS;
}

/** The only writer of the settings row. Every save runs the full validation, so a stored window is always valid. */
export async function saveSettings(
  db: Db,
  input: unknown,
): Promise<{ ok: true; settings: Settings } | { ok: false; errors: string[] }> {
  const parsed = safeParseSettings(input);
  if (!parsed.ok) return parsed;

  const settings: Settings = { ...parsed.settings, templatesSaved: true };
  const errors = validateSettings(settings);
  if (errors.length > 0) return { ok: false, errors };

  await db
    .insert(settingsTable)
    .values({ id: SETTINGS_ROW_ID, value: settings, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settingsTable.id, set: { value: settings, updatedAt: new Date() } });
  return { ok: true, settings };
}
