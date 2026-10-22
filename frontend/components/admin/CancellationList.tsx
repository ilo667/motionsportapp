import type { Cancellation } from "@/lib/api";

const KYIV = "Europe/Kyiv";

// "17:42" for today's page, "20 жовт., 15:02" when the date matters
export function formatCancelledAt(iso: string | null, withDate: boolean): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: KYIV,
    hour: "2-digit",
    minute: "2-digit",
    ...(withDate ? { day: "numeric", month: "short" } : {}),
  }).format(new Date(iso));
}

export interface CancellationItem extends Cancellation {
  label?: string; // what to show instead of the name (client history shows the training date)
}

interface CancellationListProps {
  title: string;
  items: CancellationItem[];
  withDate?: boolean;
}

// Who cancelled or moved and why. Used on the coach's today page, in the calendar modal and in client history
export function CancellationList({ title, items, withDate = false }: CancellationListProps) {
  if (items.length === 0) return null;

  return (
    <div className="flex flex-col space-y-2">
      <p className="text-muted text-xs uppercase tracking-wide">{title}</p>
      <ul className="flex flex-col space-y-2">
        {items.map((c) => (
          <li key={c.bookingId} className="text-sm">
            <div className="flex items-baseline justify-between space-x-2">
              <span className="text-body">
                {c.label ?? c.displayName}
                {c.switchedToTime ? (
                  <span className="ml-2 text-xs text-amber-400 border border-amber-400/40 rounded-full px-2">
                    на {c.switchedToTime}
                  </span>
                ) : (
                  <span className="ml-2 text-xs text-danger border border-danger/40 rounded-full px-2">скасовано</span>
                )}
              </span>
              <span className="text-muted text-xs whitespace-nowrap tabular-nums">
                {formatCancelledAt(c.cancelledAt, withDate)}
              </span>
            </div>
            <p className="text-muted italic break-words">{c.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
