"use client";
import { useState } from "react";
import { api, type Cancellation } from "@/lib/api";
import { feeLabel } from "@/lib/cancelFee";
import { kyivDateTime } from "@/lib/dates";
import { kyivTime } from "@/lib/kyivTime";
import { errorText } from "@/lib/apiErrors";
import { Badge } from "@/components/ui/Badge";

function formatCancelledAt(iso: string | null, withDate: boolean): string {
  if (!iso) return "";
  return withDate ? kyivDateTime(iso) : kyivTime(iso);
}

export interface CancellationItem extends Cancellation {
  label?: string; // instead of the name (client history shows the training date)
  moveInLabel?: boolean; // the label already shows the move, so no target-time badge
}

interface CancellationListProps {
  title?: string;
  items: CancellationItem[];
  withDate?: boolean;
}

// A late cancellation shows its fee, with «Не списувати» until the money is returned
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
      setError(errorText(err, "Не вдалося скасувати списання. Оновіть сторінку."));
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
                      <Badge tone="warn" className="ml-2">
                        на {c.switchedToTime}
                      </Badge>
                    )
                  ) : (
                    <Badge tone="danger" className="ml-2">
                      скасовано
                    </Badge>
                  )}
                </span>
                <span className="text-muted text-xs whitespace-nowrap tabular-nums">
                  {formatCancelledAt(c.cancelledAt, withDate)}
                </span>
              </div>
              <p className="text-muted italic break-words">{c.reason}</p>
              {fee && (
                <div className="flex items-center justify-between space-x-2 mt-1">
                  <Badge tone={fee.waived ? "none" : "warn"}>{feeLabel(fee)}</Badge>
                  {!fee.waived && !fee.refundDone && (
                    <button
                      type="button"
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
      {error && (
        <p role="alert" className="text-danger text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
