"use client";
import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import FullCalendar from "@fullcalendar/react";
import classicThemePlugin from "@fullcalendar/react/themes/classic";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import ukLocale from "@fullcalendar/react/locales/uk";
import type { DatesSetInfo, EventClickInfo, DateClickInfo } from "@fullcalendar/react";
import { api, AdminMember, CalendarSlot, Cancellation, TrainingType } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { useIsClient } from "@/lib/clientStore";
import { TYPE_COLORS } from "@/lib/trainingTypes";
import { CancellationList } from "@/components/admin/CancellationList";
import { AdminMenu } from "@/components/admin/AdminMenu";

const TYPE_LABELS: Record<TrainingType, string> = {
  групові: "Групові",
  персональні: "Персональні",
  спліт: "Спліт",
};

// Short labels for calendar events — full names don't fit a day column
const TYPE_SHORT: Record<TrainingType, string> = {
  групові: "Груп.",
  персональні: "Перс.",
  спліт: "Спліт",
};

const TYPES: TrainingType[] = ["групові", "персональні", "спліт"];
const GROUP_TIMES = ["19:00", "20:00"];
// Member pickers per type: персональні exactly 1, спліт 1 required + 2 optional
const MEMBER_FIELDS: Record<TrainingType, number> = { групові: 0, персональні: 1, спліт: 3 };
const TIME_RE = /^([01]\d|2[0-3]):(00|15|30|45)$/;
const FIELD_CLASS = "input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none";

// A member of an assigned training: cancelled, paid (trainings left in a package of that type) or not paid
function memberLabel(m: { booked: boolean; packageLeft: number }) {
  if (!m.booked) return { text: "скасувала", className: "text-muted" };
  if (m.packageLeft > 0) return { text: `оплачено · залишилось ${m.packageLeft}`, className: "text-teal" };
  return { text: "не оплачено", className: "text-muted" };
}

const ERROR_TEXTS: [string, string][] = [
  ["Time is already taken", "На цей час уже є тренування"],
  ["taken by an assigned training", "На 19:00 чи 20:00 уже стоїть персональне тренування"],
  ["in the past", "Цей час уже минув"],
  ["Attendance already marked", "Цій людині вже поставили відмітку, її не можна прибрати"],
];

function errorText(err: unknown, fallback: string) {
  const raw = err instanceof Error ? err.message : "";
  return ERROR_TEXTS.find(([needle]) => raw.includes(needle))?.[1] ?? fallback;
}

function hourOf(slotTime: string) {
  return parseInt(slotTime.slice(0, 2), 10);
}

// Clicking today or a future day opens "Додати тренування"; past days do nothing, so no pointer there
function clickableDayClass(info: { isPast: boolean }) {
  return info.isPast ? "" : "mg-clickable";
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

type Modal =
  | { mode: "add"; date: string }
  | { mode: "edit"; slot: CalendarSlot };

export default function CalendarPage() {
  const router = useRouter();
  // FullCalendar renders in the browser only
  const mounted = useIsClient();
  const [slots, setSlots] = useState<CalendarSlot[]>([]);
  const [members, setMembers] = useState<AdminMember[]>([]);
  // Months covering the visible range ("2026-10,2026-11"): a week can span two months
  const [visibleMonths, setVisibleMonths] = useState("");

  const [modal, setModal] = useState<Modal | null>(null);
  const [selectedType, setSelectedType] = useState<TrainingType>("групові");
  const [time, setTime] = useState("");
  // One entry per member picker; "" = not chosen
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Loaded when an event's modal opens; keyed by slot so a late answer for another slot is ignored
  const [cancellations, setCancellations] = useState<{ slotId: string; items: Cancellation[] } | null>(null);

  const handleAuthError = useCallback((err: unknown) => {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) router.push("/admin/login");
  }, [router]);

  useEffect(() => {
    api.getMembers().then(setMembers).catch(handleAuthError);
  }, [handleAuthError]);

  const fetchMonths = useCallback(async (months: string) => {
    if (!months) return;
    try {
      const data = await Promise.all(months.split(",").map((m) => api.getCalendar(m)));
      setSlots(data.flat());
    } catch (err: unknown) {
      handleAuthError(err);
    }
  }, [handleAuthError]);

  const handleDatesSet = useCallback((arg: DatesSetInfo) => {
    // Every month touched by the visible range: a week can span 2 months, the month view 3 (with edge days)
    const lastVisible = new Date(arg.end.getTime() - 1); // end is exclusive
    const list: string[] = [];
    for (let d = new Date(arg.start.getFullYear(), arg.start.getMonth(), 1); d <= lastVisible; d.setMonth(d.getMonth() + 1)) {
      list.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
    }
    const months = list.join(",");
    if (months !== visibleMonths) {
      setVisibleMonths(months);
      fetchMonths(months);
    }
  }, [visibleMonths, fetchMonths]);

  const events = slots.map((s) => {
    const start = `${s.localDate}T${s.slotTime}:00`;
    const end = new Date(new Date(start).getTime() + 60 * 60 * 1000);
    const colors = TYPE_COLORS[s.trainingType];
    // Group: how full it is. Assigned: who has a package ("Спліт · Катя ✓, Оля")
    const detail = s.trainingType === "групові"
      ? `${s.bookedCount}/${s.capacity}`
      : s.members.map((m) => `${m.displayName}${m.booked && m.packageLeft > 0 ? " ✓" : ""}`).join(", ") || "без людей";
    return {
      id: s.slotId,
      title: `${TYPE_SHORT[s.trainingType]} · ${detail}`,
      // Timed events (1 h) so the week-with-hours view places them on their hour; the time is shown by FullCalendar
      start,
      end,
      // v7 names (v6 backgroundColor/borderColor/textColor are ignored)
      color: colors.bg,
      contrastColor: colors.text,
      extendedProps: { slot: s },
    };
  });

  // Evening by default; widen when an assigned training is earlier or later
  const minHour = Math.min(17, ...slots.map((s) => hourOf(s.slotTime)));
  const maxHour = Math.min(24, Math.max(22, ...slots.map((s) => hourOf(s.slotTime) + 2)));

  const fieldsFor = (type: TrainingType, ids: string[] = []) =>
    Array.from({ length: MEMBER_FIELDS[type] }, (_, i) => ids[i] ?? "");

  const openAddModal = (date: string, clickedTime = "") => {
    setSelectedType("групові");
    setTime(clickedTime);
    setMemberIds([]);
    setError("");
    setModal({ mode: "add", date });
  };

  const openEditModal = (slot: CalendarSlot) => {
    setSelectedType(slot.trainingType);
    setTime(slot.slotTime);
    setMemberIds(fieldsFor(slot.trainingType, slot.members.map((m) => m.id)));
    setError("");
    setModal({ mode: "edit", slot });
    setCancellations(null);
    api.getSlotCancellations(slot.slotId)
      .then((items) => setCancellations({ slotId: slot.slotId, items }))
      .catch(() => setCancellations({ slotId: slot.slotId, items: [] }));
  };

  const selectType = (type: TrainingType) => {
    setSelectedType(type);
    setMemberIds((ids) => fieldsFor(type, ids));
  };

  const handleEventClick = (arg: EventClickInfo) => {
    openEditModal(arg.event.extendedProps.slot as CalendarSlot);
  };

  const handleDateClick = (arg: DateClickInfo) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Month view gives "YYYY-MM-DD", week-with-hours gives "YYYY-MM-DDTHH:mm:ss+03:00" (prefills the time)
    const date = arg.dateStr.slice(0, 10);
    const clicked = new Date(date + "T12:00:00");
    if (clicked < today) return;
    openAddModal(date, arg.dateStr.slice(11, 16));
  };

  const chosenMembers = memberIds.filter(Boolean);

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setSaving(true);
    setError("");
    try {
      await fn();
      await fetchMonths(visibleMonths);
      setModal(null);
    } catch (err: unknown) {
      setError(errorText(err, fallback));
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = () => {
    if (modal?.mode !== "add") return;
    if (selectedType === "групові") {
      return run(
        () => Promise.all(GROUP_TIMES.map((t) => api.upsertGroupSlot(modal.date, t))),
        "Помилка збереження. Спробуйте ще раз.",
      );
    }
    if (!TIME_RE.test(time)) return setError("Вкажіть час з кроком 15 хвилин, наприклад 18:30");
    if (!memberIds[0]) return setError("Виберіть людину");
    return run(
      () => api.createAssignedSlot(modal.date, { slotTime: time, trainingType: selectedType, memberIds: chosenMembers }),
      "Помилка збереження. Спробуйте ще раз.",
    );
  };

  const handleSaveMembers = () => {
    if (modal?.mode !== "edit") return;
    if (!memberIds[0]) return setError("Виберіть людину");
    return run(() => api.updateSlotMembers(modal.slot.slotId, chosenMembers), "Помилка збереження. Спробуйте ще раз.");
  };

  const handleCancelSlot = () => {
    if (modal?.mode !== "edit") return;
    return run(() => api.cancelSlot(modal.slot.slotId), "Помилка. Спробуйте ще раз.");
  };

  const modalDate = modal ? (modal.mode === "add" ? modal.date : modal.slot.localDate) : "";
  const editing = modal?.mode === "edit" ? modal.slot : null;
  const assigned = selectedType !== "групові";
  // The trainer's own and unassigned clients, plus anyone already on this training (another trainer's client
  // must not silently disappear from the picker and be dropped on save)
  const pickerMembers: { id: string; displayName: string; memberCode?: string }[] = [
    ...members,
    ...(editing?.members.filter((sm) => !members.some((m) => m.id === sm.id)) ?? []),
  ];

  return (
    <PageLayout variant="top" action={<AdminMenu />}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">
        Календар
      </h1>

      <div className="flex items-center -m-1 flex-wrap mb-4">
        {TYPES.map((t) => (
          <span key={t} className="m-1 flex items-center text-xs px-2 py-1 rounded-full border" style={{ borderColor: TYPE_COLORS[t].border, color: TYPE_COLORS[t].text, backgroundColor: TYPE_COLORS[t].bg }}>
            {TYPE_LABELS[t]}
          </span>
        ))}
      </div>

      {/* FullCalendar v7 has no stable fc-* class names — theme it only via palette variables.
          The selector beats palette.css's [data-color-scheme=dark] (higher specificity). */}
      <style>{`
        .mg-calendar [data-color-scheme] {
          --fc-classic-background: transparent;
          --fc-classic-foreground: var(--color-body);
          --fc-classic-muted-foreground: var(--color-muted);
          --fc-classic-faint-foreground: var(--color-line);
          --fc-classic-border: var(--color-line);
          --fc-classic-strong-border: var(--color-line);
          --fc-classic-faint: rgba(26, 32, 64, 0.3);
          --fc-classic-muted: rgba(26, 32, 64, 0.5);
          --fc-classic-strong: var(--color-line);
          --fc-classic-today: rgba(147, 210, 60, 0.08);
          --fc-classic-highlight: rgba(147, 210, 60, 0.15);
          --fc-classic-primary: var(--color-accent);
          --fc-classic-primary-foreground: var(--color-on-teal);
          --fc-classic-button: transparent;
          --fc-classic-button-border: var(--color-line);
          --fc-classic-button-strong: var(--color-line);
          --fc-classic-button-strong-border: var(--color-line);
          --fc-classic-button-outline: var(--color-line);
          --fc-classic-button-foreground: var(--color-body);
        }
        /* Events are clickable (edit / cancel); role="button" is the only stable hook on them in v7 */
        .mg-calendar [role="button"], .mg-calendar .mg-clickable { cursor: pointer; }
      `}</style>

      <div className="mg-calendar rounded-xl border border-line p-3 overflow-hidden">
        {!mounted ? <div className="h-64 flex items-center justify-center text-muted text-sm">Завантаження...</div> : <FullCalendar
          plugins={[classicThemePlugin, dayGridPlugin, timeGridPlugin, interactionPlugin]}
          colorScheme="dark"
          initialView="timeGridWeek"
          locale={ukLocale}
          height="auto"
          events={events}
          datesSet={handleDatesSet}
          eventClick={handleEventClick}
          dateClick={handleDateClick}
          dayCellClass={clickableDayClass}
          dayLaneClass={clickableDayClass}
          headerToolbar={{ left: "prev,next", center: "title", right: "timeGridWeek,dayGridMonth" }}
          firstDay={1}
          slotMinTime={`${pad(minHour)}:00:00`}
          slotMaxTime={`${pad(maxHour)}:00:00`}
          allDaySlot={false}
          eventDisplay="block"
          views={{
            // "26 жовт. – 1 лист." instead of "жовт. 2026 р. – лист. 2026 р.", which pushed the view buttons to a new row
            timeGridWeek: { titleFormat: { day: "numeric", month: "short" } },
          }}
          eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
          fixedWeekCount={false}
        />}
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative w-full max-w-sm bg-surface border border-line rounded-2xl p-5 space-y-4 max-h-full overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div>
              <p className="text-muted text-xs uppercase tracking-wide mb-1">
                {new Date(modalDate + "T12:00:00").toLocaleDateString("uk-UA", { weekday: "long", day: "numeric", month: "long" })}
              </p>
              <p className="font-geologica font-semibold text-heading">
                {editing ? `${TYPE_LABELS[editing.trainingType]} ${editing.slotTime}` : "Додати тренування"}
              </p>
              {editing?.trainingType === "групові" && (
                <p className="text-muted text-xs mt-1">Записано {editing.bookedCount} з {editing.capacity}</p>
              )}
            </div>

            {editing && editing.trainingType !== "групові" && editing.members.length > 0 && (
              <ul className="space-y-1">
                {editing.members.map((m) => {
                  const label = memberLabel(m);
                  return (
                    <li key={m.id} className="flex items-center justify-between text-sm">
                      <span className="text-body">{m.displayName}</span>
                      <span className={label.className}>{label.text}</span>
                    </li>
                  );
                })}
              </ul>
            )}

            {editing && cancellations?.slotId === editing.slotId && (
              <CancellationList title="Скасували" items={cancellations.items} withDate />
            )}

            {/* Тип — тільки при додаванні. Ще одне тренування в цей день: клікніть день знову */}
            {!editing && (
              <div className="flex flex-col space-y-2">
                {TYPES.map((t) => (
                  <button
                    key={t}
                    onClick={() => selectType(t)}
                    className={`flex items-center justify-between px-4 py-3 rounded-xl border text-sm transition-colors ${selectedType === t ? "" : "border-line"}`}
                    style={selectedType === t ? { borderColor: TYPE_COLORS[t].border, backgroundColor: TYPE_COLORS[t].bg, color: TYPE_COLORS[t].text } : {}}
                  >
                    <span>{TYPE_LABELS[t]}</span>
                    {selectedType === t && <span>✓</span>}
                  </button>
                ))}
              </div>
            )}

            {!editing && !assigned && (
              <p className="text-muted text-xs">Буде створено слоти 19:00 і 20:00, їх бачать усі</p>
            )}

            {!editing && assigned && (
              <div>
                <label htmlFor="slot-time" className="block text-muted text-xs mb-2 uppercase tracking-wide">Час</label>
                <input
                  id="slot-time"
                  type="time"
                  step={900}
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className={`${FIELD_CLASS} [color-scheme:dark]`}
                />
              </div>
            )}

            {assigned && (
              <div className="flex flex-col space-y-2">
                <p className="text-muted text-xs uppercase tracking-wide">
                  {selectedType === "спліт" ? "Люди (до трьох)" : "Людина"}
                </p>
                {memberIds.map((id, i) => (
                  <select
                    key={i}
                    aria-label={`Людина ${i + 1}`}
                    value={id}
                    onChange={(e) => setMemberIds((ids) => ids.map((v, j) => (j === i ? e.target.value : v)))}
                    className={FIELD_CLASS}
                  >
                    <option value="">{i === 0 ? "Виберіть людину" : "Не вибрано (необовʼязково)"}</option>
                    {pickerMembers
                      .filter((m) => m.id === id || !memberIds.includes(m.id))
                      .map((m) => (
                        <option key={m.id} value={m.id}>{m.memberCode ? `${m.displayName} · ${m.memberCode}` : m.displayName}</option>
                      ))}
                  </select>
                ))}
                <p className="text-muted text-xs">Тренування побачать і зможуть оплатити тільки вибрані люди</p>
              </div>
            )}

            {error && <p className="text-danger text-sm">{error}</p>}

            <div className="flex flex-col space-y-2">
              {(!editing || assigned) && (
                <button
                  onClick={editing ? handleSaveMembers : handleAdd}
                  disabled={saving}
                  className="btn-primary w-full py-3 rounded-xl text-sm font-medium transition-colors disabled:opacity-60"
                >
                  {saving ? "Зачекайте..." : "Зберегти"}
                </button>
              )}
              {editing && (
                <button
                  onClick={handleCancelSlot}
                  disabled={saving}
                  className="btn-ghost hover-danger w-full py-3 rounded-xl border text-sm transition-colors disabled:opacity-60"
                >
                  Скасувати тренування {editing.slotTime}
                </button>
              )}
              <button
                onClick={() => setModal(null)}
                className="text-muted text-sm py-2 transition-colors hover:text-body"
              >
                Закрити
              </button>
            </div>
          </div>
        </div>
      )}
    </PageLayout>
  );
}
