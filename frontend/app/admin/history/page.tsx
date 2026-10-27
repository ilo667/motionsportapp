"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, AdminSlotView, AttendanceStatus, HistoryDay, TrainingType } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { AttendanceButton } from "@/components/admin/AttendanceButton";
import { CancellationList } from "@/components/admin/CancellationList";
import { TYPE_COLORS } from "@/lib/trainingTypes";
import { longDay } from "@/lib/dates";

const TYPE_LABEL: Record<TrainingType, string> = {
  групові: "Групові",
  персональні: "Персональне",
  спліт: "Спліт",
};

// "11 прийшли з 12 · 1 скасування" for the collapsed day row
function daySummary(day: HistoryDay) {
  if (day.status === "CANCELLED") return "День скасовано";
  const active = day.slots.filter((s) => s.status === "ACTIVE");
  const people = active.flatMap((s) => s.participants);
  const present = people.filter((p) => p.attendanceStatus === "PRESENT").length;
  const cancelled = day.slots.reduce((n, s) => n + s.cancellations.length, 0);
  const parts = [people.length > 0 ? `${present} прийшли з ${people.length}` : "Без записів"];
  if (cancelled > 0) parts.push(`скасувань: ${cancelled}`);
  const offSlots = day.slots.filter((s) => s.status === "CANCELLED").map((s) => s.slotTime);
  if (offSlots.length > 0) parts.push(`${offSlots.join(", ")} скасовано`);
  return parts.join(" · ");
}

function HistorySlot({
  slot,
  onAttendance,
}: {
  slot: AdminSlotView;
  onAttendance: (bookingId: string, next: AttendanceStatus) => void;
}) {
  const colors = TYPE_COLORS[slot.trainingType];
  const present = slot.participants.filter((p) => p.attendanceStatus === "PRESENT").length;

  return (
    <div className="bg-surface border border-line rounded-xl p-3 flex flex-col space-y-3">
      <div className="flex items-center justify-between space-x-2">
        <span className="font-geologica font-semibold text-heading">{slot.slotTime}</span>
        {slot.status === "CANCELLED" ? (
          <span className="text-xs text-danger border border-danger/40 rounded-full px-2 py-0.5">Скасовано</span>
        ) : (
          <span
            className="text-xs border rounded-full px-2 py-0.5"
            style={{ backgroundColor: colors.bg, borderColor: colors.border, color: colors.text }}
          >
            {TYPE_LABEL[slot.trainingType]} · {present}/{slot.participants.length}
          </span>
        )}
      </div>

      {slot.status === "ACTIVE" &&
        (slot.participants.length === 0 ? (
          <p className="text-muted text-sm">Немає записів</p>
        ) : (
          <ul className="flex flex-col space-y-2">
            {slot.participants.map((p) => (
              <li key={p.bookingId} className="flex items-center justify-between space-x-2">
                <span className={`text-body text-sm${p.guestOf ? " pl-4" : ""}`}>
                  {p.displayName}
                  {p.switchedFromTime && <span className="ml-2 text-xs text-warn">з {p.switchedFromTime}</span>}
                  {p.guestOf && (
                    <span className="ml-2 text-xs text-subtle border border-line rounded-full px-2 py-0.5 py-0.5">
                      гість
                    </span>
                  )}
                </span>
                <AttendanceButton
                  status={p.attendanceStatus}
                  name={p.displayName}
                  onChange={(next) => onAttendance(p.bookingId, next)}
                />
              </li>
            ))}
          </ul>
        ))}

      {slot.cancellations.length > 0 && (
        <div className="border-t border-dashed border-line pt-3">
          <CancellationList title="Скасували" items={slot.cancellations} withDate />
        </div>
      )}
    </div>
  );
}

// Past trainings, newest first. Attendance is editable here at any time (no lock after "Підтвердити всіх")
export default function HistoryPage() {
  const router = useRouter();
  const [days, setDays] = useState<HistoryDay[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    async (before?: string) => {
      try {
        const page = await api.getHistory(before);
        setDays((prev) => [...(before ? (prev ?? []) : []), ...page.days]);
        setNextBefore(page.nextBefore);
        // The latest day starts expanded
        if (!before && page.days[0]) setOpen(new Set([page.days[0].localDate]));
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) router.push("/admin/login");
        else setError("Не вдалося завантажити історію.");
      }
    },
    [router],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load is async: state is set after the await, not synchronously
    load();
  }, [load]);

  const loadMore = async () => {
    if (!nextBefore) return;
    setLoadingMore(true);
    await load(nextBefore);
    setLoadingMore(false);
  };

  const toggle = (localDate: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(localDate)) next.delete(localDate);
      else next.add(localDate);
      return next;
    });

  const setAttendance = (bookingId: string, status: AttendanceStatus) =>
    setDays(
      (prev) =>
        prev?.map((d) => ({
          ...d,
          slots: d.slots.map((s) => ({
            ...s,
            participants: s.participants.map((p) =>
              p.bookingId === bookingId ? { ...p, attendanceStatus: status } : p,
            ),
          })),
        })) ?? null,
    );

  // Optimistic: the mark changes at once and rolls back if saving fails
  const changeAttendance = async (bookingId: string, previous: AttendanceStatus, next: AttendanceStatus) => {
    setError("");
    setAttendance(bookingId, next);
    // A guest's row carries the guest's id and is marked through its own route
    const participant = days
      ?.flatMap((d) => d.slots.flatMap((s) => s.participants))
      .find((p) => p.bookingId === bookingId);
    try {
      await api.updateParticipantAttendance({ bookingId, guestOf: participant?.guestOf ?? null }, next);
    } catch {
      setAttendance(bookingId, previous);
      setError("Не вдалося зберегти відмітку. Спробуйте ще раз.");
    }
  };

  return (
    <PageLayout variant="top" loading={!days && !error} action={<AdminMenu />}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">Історія</h1>

      {error && <p className="text-danger text-sm mb-4">{error}</p>}

      {days && days.length === 0 && <p className="text-muted text-sm">Минулих тренувань ще немає.</p>}

      {days && days.length > 0 && (
        <div className="flex flex-col space-y-3">
          {days.map((day) => {
            const expanded = open.has(day.localDate);
            const dayTitle = (
              <span className="flex flex-col">
                <span className="text-heading text-sm font-semibold capitalize">{longDay(day.localDate)}</span>
                <span className={`text-xs ${day.status === "CANCELLED" ? "text-danger" : "text-muted"}`}>
                  {daySummary(day)}
                </span>
              </span>
            );
            return (
              <div key={day.localDate} className="border border-line rounded-2xl overflow-hidden">
                {day.status === "CANCELLED" ? (
                  // Nothing to expand on a cancelled day: a plain row, no arrow
                  <div className="bg-surface px-4 py-3">{dayTitle}</div>
                ) : (
                  <button
                    onClick={() => toggle(day.localDate)}
                    aria-expanded={expanded}
                    className="w-full text-left bg-surface px-4 py-3 flex items-start justify-between space-x-3 hover:bg-surface/70 transition-colors"
                  >
                    {dayTitle}
                    <span
                      className={`text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
                      aria-hidden="true"
                    >
                      ▾
                    </span>
                  </button>
                )}
                {expanded && day.status !== "CANCELLED" && (
                  <div className="border-t border-line p-3 flex flex-col space-y-3">
                    {day.slots.map((slot) => (
                      <HistorySlot
                        key={slot.id}
                        slot={slot}
                        onAttendance={(bookingId, next) => {
                          const previous =
                            slot.participants.find((p) => p.bookingId === bookingId)?.attendanceStatus ?? "UNMARKED";
                          changeAttendance(bookingId, previous, next);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {nextBefore && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="btn-ghost w-full py-3 rounded-lg border text-sm transition-colors disabled:opacity-60"
            >
              {loadingMore ? "Завантаження..." : "Показати ще"}
            </button>
          )}
        </div>
      )}
    </PageLayout>
  );
}
