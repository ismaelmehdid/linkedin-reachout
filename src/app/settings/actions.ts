'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { requireSession } from '@/lib/auth/require-session';
import { formDataToSettings } from '@/lib/settings/form';
import { saveSettings } from '@/lib/settings/repo';

export type SaveSettingsState = { ok: boolean; errors: string[] };

export async function saveSettingsAction(_prev: SaveSettingsState, formData: FormData): Promise<SaveSettingsState> {
  await requireSession();
  const result = await saveSettings(await getDb(), formDataToSettings(formData));
  if (!result.ok) return { ok: false, errors: result.errors };

  revalidatePath('/settings');
  // The dashboard shows what Start is blocked by, which depends on the saved templates.
  revalidatePath('/');
  return { ok: true, errors: [] };
}
