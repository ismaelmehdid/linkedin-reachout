import { desc, isNotNull } from 'drizzle-orm';
import { connection } from 'next/server';
import { getDb } from '@/db/client';
import { leads } from '@/db/schema';
import { leadTemplateValues } from '@/lib/engine/lead-templates';
import { getSettings } from '@/lib/settings/repo';
import SettingsForm, { type PreviewLead } from './SettingsForm';

const PREVIEW_LEAD_LIMIT = 50;

export default async function SettingsPage() {
  // Read the database per request, never at build time.
  await connection();
  const db = await getDb();
  const [settings, rows] = await Promise.all([
    getSettings(db),
    db
      .select({
        id: leads.id,
        firstName: leads.firstName,
        lastName: leads.lastName,
        headline: leads.headline,
        company: leads.company,
        position: leads.position,
        location: leads.location,
      })
      .from(leads)
      .where(isNotNull(leads.firstName))
      .orderBy(desc(leads.createdAt), desc(leads.id))
      .limit(PREVIEW_LEAD_LIMIT),
  ]);

  const previewLeads: PreviewLead[] = rows.map((row) => ({
    id: row.id,
    name: [row.firstName, row.lastName].filter(Boolean).join(' '),
    values: leadTemplateValues(row),
  }));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <SettingsForm settings={settings} leads={previewLeads} />
    </main>
  );
}
