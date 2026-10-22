"use client";
import { useState } from "react";
import { api, AdminSlotView, AttendanceStatus } from "@/lib/api";

interface SlotCardProps {
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

export function SlotCard({ slot, onMutate }: SlotCardProps) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const isGroup = slot.trainingType === "групові";
  // "мало учасників" is about group trainings; personal ones are for 1–3 assigned people
  const belowMin = isGroup && slot.status === "ACTIVE" && slot.bookedCount < 3;
  const allPresent = slot.participants.length > 0 && slot.participants.every(p => p.attendanceStatus === "PRESENT");

  return (
    <div className={`rounded-xl border-2 p-5 ${slot.status === "CANCELLED" ? "bg-surface border-line opacity-60" : "bg-surface border-line"}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-baseline space-x-3">
          <span className="font-geologica font-semibold text-title text-heading">
            {slot.slotTime}
          </span>
          {!isGroup && (
            <span className="text-muted text-sm">{slot.trainingType === "спліт" ? "Спліт" : "Індивідуальне"}</span>
          )}
        </div>
        <div className="flex items-center space-x-3">
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
                    disabled={allPresent}
                    onClick={() =>
                      onMutate(() =>
                        api.updateAttendance(p.bookingId, nextStatus(p.attendanceStatus))
                      )
                    }
                    title={`Змінити відвідуваність: ${p.attendanceStatus}`}
                    className={`w-8 h-8 rounded-full border text-xs font-bold shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${ATTENDANCE_COLORS[p.attendanceStatus]}`}
                  >
                    {ATTENDANCE_LABELS[p.attendanceStatus]}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col space-y-2">
            {slot.participants.length > 0 && (
              allPresent ? (
                <p className="text-teal text-sm text-center py-2">✓ Всі учасники підтверджені</p>
              ) : (
                <button
                  onClick={() => onMutate(() => api.markAllAttendance(slot.id))}
                  className="btn-secondary w-full py-2.5 rounded-lg border text-sm transition-colors"
                >
                  Підтвердити всіх
                </button>
              )
            )}

            {!confirmCancel ? (
              <button
                onClick={() => setConfirmCancel(true)}
                className="btn-ghost hover-danger w-full py-2.5 rounded-lg border text-sm transition-colors"
              >
                Відмінити тренування
              </button>
            ) : (
              <div className="rounded-lg border border-danger bg-danger/5 p-3 space-y-2">
                <p className="text-danger text-xs">
                  Відмінити тренування о {slot.slotTime}? Всі записи буде скасовано.
                </p>
                <div className="flex space-x-2">
                  <button
                    onClick={() => {
                      setConfirmCancel(false);
                      onMutate(() => api.cancelSlot(slot.id));
                    }}
                    className="btn-danger flex-1 py-2 rounded-md text-xs font-medium transition-colors"
                  >
                    Відмінити
                  </button>
                  <button
                    onClick={() => setConfirmCancel(false)}
                    className="btn-ghost flex-1 py-2 rounded-md border text-xs transition-colors"
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