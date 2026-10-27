"use client";
import { useState } from "react";
import { api, type Cancellation } from "@/lib/api";

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
  moveInLabel?: boolean; // the label already says «19:00 → 20:00», so no «на 20:00» badge
}

interface CancellationListProps {
  title?: string; // none when the page already has a heading
  items: CancellationItem[];
  withDate?: boolean;
}

// What a late cancellation cost: «списано», «повернути 350 ₴», «не списано» once waived
function feeLabel(fee: NonNullable<Cancellation["fee"]>) {
  if (fee.waived) return "не списано";
  if (fee.kind === "HALF" && fee.refundUah) {
    return `${fee.refundDone ? "повернено" : "повернути"} ${fee.refundUah} ₴`;
  }
  return "списано";
}

// Who cancelled or moved and why. Used on the trainer's today page, in the calendar modal and in client history.
// A late cancellation shows what it cost, with «Не списувати» until the money is returned
export function CancellationList({ title, items, withDate = false }: CancellationListProps) {
  const [waived, setWaived] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  if (items.length === 0) return null;

  const waive = async (bookingId: string) => {
    setBusyId(bookingId);
    setError("");
    try {
      await api.waiveCancelFee(bookingId);
      setWaived((prev) => new Set(prev).add(bookingId));
    } catch (err) {
      setError(
        (err as Error).message === "Money already returned"
          ? "Гроші вже повернено, списання не скасувати."
          : "Не вдалося скасувати списання. Оновіть сторінку.",
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col space-y-2">
      {title && <p className="text-muted text-xs uppercase tracking-wide">{title}</p>}
      <ul className="flex flex-col space-y-2">
        {items.map((c) => {
          const fee = c.fee && waived.has(c.bookingId) ? { ...c.fee, waived: true, refundUah: null } : c.fee;
          return (
            <li key={c.bookingId} className="text-sm">
              <div className="flex items-baseline justify-between space-x-2">
                <span className="text-body">
                  {c.label ?? c.displayName}
                  {c.switchedToTime ? (
                    !c.moveInLabel && (
                      <span className="ml-2 text-xs text-warn bg-warn-bg border border-warn-line rounded-full px-2">
                        на {c.switchedToTime}
                      </span>
                    )
                  ) : (
                    <span className="ml-2 text-xs text-danger border border-danger/40 rounded-full px-2">
                      скасовано
                    </span>
                  )}
                </span>
                <span className="text-muted text-xs whitespace-nowrap tabular-nums">
                  {formatCancelledAt(c.cancelledAt, withDate)}
                </span>
              </div>
              <p className="text-muted italic break-words">{c.reason}</p>
              {fee && (
                <div className="flex items-center justify-between space-x-2 mt-1">
                  <span
                    className={`text-xs border rounded-full px-2 ${fee.waived ? "text-subtle border-line" : "text-warn bg-warn-bg border-warn-line"}`}
                  >
                    {feeLabel(fee)}
                  </span>
                  {!fee.waived && !fee.refundDone && (
                    <button
                      onClick={() => waive(c.bookingId)}
                      disabled={busyId === c.bookingId}
                      className="text-subtle text-xs underline hover:text-body transition-colors disabled:opacity-60"
                    >
                      Не списувати
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );
}
