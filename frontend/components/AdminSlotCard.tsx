"use client";
import { useState } from "react";
import { api, AdminSlotView, AttendanceStatus } from "@/lib/api";

interface AdminSlotCardProps {
  slot: AdminSlotView;
  onMutate: (fn: () => Promise<unknown>) => Promise<void>;
}

const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = {
  PRESENT: "✓",
  ABSENT: "✗",
  UNMARKED: "—",
};

const ATTENDANCE_COLORS: Record<AttendanceStatus, string> = {
  PRESENT: "bg-teal/10 text-teal border-teal",
  ABSENT: "bg-danger/10 text-danger border-danger",
  UNMARKED: "bg-surface text-body border-muted",
};

function nextStatus(current: AttendanceStatus): AttendanceStatus {
  if (current === "UNMARKED") return "PRESENT";
  if (current === "PRESENT") return "ABSENT";
  return "UNMARKED";
}

export function AdminSlotCard({ slot, onMutate }: AdminSlotCardProps) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const belowMin = slot.status === "ACTIVE" && slot.bookedCount < 3;

  return (
    <div className={`rounded-[12px] border p-5 ${slot.status === "CANCELLED" ? "bg-surface border-line opacity-60" : "bg-surface border-line"}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="font-geologica font-semibold text-[22px] text-heading">
          {slot.slotTime}
        </span><div className="flex items-center space-x-3">
          {belowMin && (
            <span className="text-xs text-muted bg-surface border border-line rounded-full px-2 py-0.5">
              мало учасників
            </span>
          )}
          <span className="text-muted text-sm">
            {slot.bookedCount}/{slot.capacity}
          </span>
        </div>
      </div>

      {slot.status === "CANCELLED" ? (
        <p className="text-sm text-danger font-medium">Скасовано</p>
      ) : (
        <>
          {slot.participants.length === 0 ? (
            <p className="text-muted text-sm mb-3">Немає записів</p>
          ) : (
            <ul className="mb-3 space-y-2">
              {slot.participants.map((p) => (
                <li key={p.bookingId} className="flex items-center justify-between space-x-2">
                  <span className="text-body text-sm">{p.displayName}</span>
                  <button
                    onClick={() =>
                      onMutate(() =>
                        api.updateAttendance(p.bookingId, nextStatus(p.attendanceStatus))
                      )
                    }
                    title={`Змінити відвідуваність: ${p.attendanceStatus}`}
                    className={`w-8 h-8 rounded-full border text-xs font-bold shrink-0 transition-colors ${ATTENDANCE_COLORS[p.attendanceStatus]}`}
                  >
                    {ATTENDANCE_LABELS[p.attendanceStatus]}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col space-y-2">
            {slot.participants.length > 0 && (
              <button
                onClick={() => onMutate(() => api.markAllAttendance(slot.id))}
                className="btn-secondary w-full py-2.5 rounded-[8px] border text-sm transition-colors"
              >
                Підтвердити всіх
              </button>
            )}

            {!confirmCancel ? (
              <button
                onClick={() => setConfirmCancel(true)}
                className="btn-ghost hover-danger w-full py-2.5 rounded-[8px] border text-sm transition-colors"
              >
                Скасувати слот
              </button>
            ) : (
              <div className="rounded-[8px] border border-danger bg-danger/5 p-3 space-y-2">
                <p className="text-danger text-xs">
                  Скасувати слот {slot.slotTime}? Всі записи буде відмінено.
                </p>
                <div className="flex space-x-2">
                  <button
                    onClick={() => {
                      setConfirmCancel(false);
                      onMutate(() => api.cancelSlot(slot.id));
                    }}
                    className="btn-danger flex-1 py-2 rounded-[6px] text-xs font-medium transition-colors"
                  >
                    Скасувати
                  </button>
                  <button
                    onClick={() => setConfirmCancel(false)}
                    className="btn-ghost flex-1 py-2 rounded-[6px] border text-xs transition-colors"
                  >
                    Ні
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}