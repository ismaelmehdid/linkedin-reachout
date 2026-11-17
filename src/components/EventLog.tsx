import type { EventRow } from '@/db/schema';
import { eventDetail, formatLocal } from '@/lib/leads/display';

type LoggedEvent = EventRow & { leadName: string | null };

export function EventLog({ events, timezone }: { events: LoggedEvent[]; timezone: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Recent events</h2>
      {events.length === 0 && <p className="text-sm text-zinc-500">No events yet.</p>}
      <ul className="flex flex-col gap-1 text-sm">
        {events.map((event) => {
          const detail = eventDetail(event);
          return (
            <li key={event.id} className="border-b border-zinc-200 pb-1 dark:border-zinc-800">
              <span className="font-mono text-xs text-zinc-500">{formatLocal(event.createdAt, timezone)}</span>{' '}
              <span className="font-medium">{event.type}</span>
              {event.leadName && <span> · {event.leadName}</span>}
              {detail !== null && <div className="whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{detail}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
