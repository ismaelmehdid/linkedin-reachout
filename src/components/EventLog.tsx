import type { EventRow } from '@/db/schema';
import { formatLocal } from '@/lib/leads/display';

type LoggedEvent = EventRow & { leadName: string | null };

/** The rendered text of an invite or message that a dry run did not send, else null. */
function dryRunText(event: LoggedEvent): string | null {
  if (event.type !== 'invite_sent' && event.type !== 'message_sent') return null;
  if (typeof event.payload !== 'object' || event.payload === null) return null;
  const { dryRun, text } = event.payload as { dryRun?: unknown; text?: unknown };
  return dryRun === true && typeof text === 'string' ? text : null;
}

export function EventLog({ events, timezone }: { events: LoggedEvent[]; timezone: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Recent events</h2>
      {events.length === 0 && <p className="text-sm text-zinc-500">No events yet.</p>}
      <ul className="flex flex-col gap-1 text-sm">
        {events.map((event) => {
          const wouldSend = dryRunText(event);
          return (
            <li key={event.id} className="border-b border-zinc-200 pb-1 dark:border-zinc-800">
              <span className="font-mono text-xs text-zinc-500">{formatLocal(event.createdAt, timezone)}</span>{' '}
              <span className="font-medium">{event.type}</span>
              {event.leadName && <span> · {event.leadName}</span>}
              {wouldSend !== null && (
                <div className="whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{`would send: ${wouldSend}`}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
