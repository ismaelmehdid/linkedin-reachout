import { EventLog } from '@/components/EventLog';
import { ImportForm } from '@/components/ImportForm';
import { LeadTable, type LeadRow } from '@/components/LeadTable';
import { StatusBar } from '@/components/StatusBar';
import { getDb } from '@/db/client';
import { leadStatus, type Lead, type LeadStatus } from '@/db/schema';
import { getAppState } from '@/lib/engine/state';
import { getUsage } from '@/lib/engine/usage';
import { getEnv } from '@/lib/env';
import { dashboardBanners, describeNextAction, formatLocal, leadDisplayName } from '@/lib/leads/display';
import { countLeadsByStatus, LEAD_LIST_LIMIT, listLeads, listRecentEvents } from '@/lib/leads/repo';
import { getSettings } from '@/lib/settings/repo';

const RECENT_EVENT_COUNT = 50;

const STATUSES: readonly string[] = leadStatus.enumValues;

/** The `?status=` filter, or null for every status (an unknown value included). */
function parseStatusFilter(value: string | string[] | undefined): LeadStatus | null {
  return typeof value === 'string' && STATUSES.includes(value) ? (value as LeadStatus) : null;
}

function toLeadRow(lead: Lead, timezone: string): LeadRow {
  const next = describeNextAction(lead);
  return {
    id: lead.id,
    name: leadDisplayName(lead),
    headline: lead.headline,
    linkedinUrl: lead.linkedinUrl,
    status: lead.status,
    failureReason: lead.failureReason,
    lastAction: lead.lastAction,
    lastActionAt: lead.lastActionAt && formatLocal(lead.lastActionAt, timezone),
    nextAction: next?.label ?? null,
    nextActionDueAt: next?.dueAt ? formatLocal(next.dueAt, timezone) : null,
    paused: lead.paused,
  };
}

export default async function DashboardPage({ searchParams }: PageProps<'/'>) {
  const status = parseStatusFilter((await searchParams).status);
  // The real clock enters here; the library functions only receive it.
  const now = new Date();
  const db = await getDb();
  const settings = await getSettings(db);
  const timezone = settings.window.timezone;
  const [state, counts, usage, leads, events] = await Promise.all([
    getAppState(db),
    countLeadsByStatus(db),
    getUsage(db, now, timezone),
    listLeads(db, status ? { status } : {}),
    listRecentEvents(db, RECENT_EVENT_COUNT),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6">
      <StatusBar
        counts={leadStatus.enumValues.map((s) => ({ status: s, count: counts[s] }))}
        usage={usage}
        caps={settings.caps}
        banners={dashboardBanners(state, { dryRun: getEnv().dryRun, now, timezone })}
        running={state.running}
      />
      <ImportForm />
      <div className="flex flex-col gap-2">
        <LeadTable rows={leads.map((lead) => toLeadRow(lead, timezone))} statuses={[...STATUSES]} activeStatus={status} />
        {leads.length === LEAD_LIST_LIMIT && (
          <p className="text-sm text-zinc-500">Showing the {LEAD_LIST_LIMIT} most recently updated leads.</p>
        )}
      </div>
      <EventLog events={events} timezone={timezone} />
    </main>
  );
}
