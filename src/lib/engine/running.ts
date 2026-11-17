import type { Db } from '@/db/types';
import { getSettings } from '@/lib/settings/repo';
import { startBlockers } from '@/lib/settings/settings';
import { setRunning } from './state';

/**
 * Sets the state the user asked for, never a toggle, so a stale page cannot restart sending after an
 * auto-pause. Pausing always works and keeps the auto-pause reason and the error streak. Starting is
 * refused while `startBlockers` returns anything; then the state is left as it is and the blockers say why.
 */
export async function setRunningUnlessBlocked(db: Db, running: boolean): Promise<{ blockers: string[] }> {
  if (running) {
    const blockers = startBlockers(await getSettings(db));
    if (blockers.length > 0) return { blockers };
  }
  await setRunning(db, running);
  return { blockers: [] };
}
