"use client";
import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import FullCalendar from "@fullcalendar/react";
import classicThemePlugin from "@fullcalendar/react/themes/classic";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import ukLocale from "@fullcalendar/react/locales/uk";
import type { DatesSetInfo, EventClickInfo, DateClickInfo } from "@fullcalendar/react";
import { api, CalendarSlot, TrainingType } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";

const TYPE_COLORS: Record<TrainingType, { bg: string; border: string; text: string }> = {
  групові:       { bg: "#14532d", border: "#93d23c", text: "#bbf7d0" },
  індивідуальні: { bg: "#3b2f00", border: "#eab308", text: "#fef08a" },
  спліт:         { bg: "#7c2d12", border: "#fb923c", text: "#fed7aa" },
};

const TYPE_LABELS: Record<TrainingType, string> = {
  групові: "Групові",
  індивідуальні: "Індивідуальні",
  спліт: "Спліт",
};

const TYPES: TrainingType[] = ["групові", "індивідуальні", "спліт"];
const SLOT_TIMES = ["19:00", "20:00"] as const;

interface Modal {
  date: string;
  existingSlot: CalendarSlot | null; // if editing a specific slot
}

export default function CalendarPage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [slots, setSlots] = useState<CalendarSlot[]>([]);
  const [currentMonth, setCurrentMonth] = useState("");

  useEffect(() => { setMounted(true); }, []);
  const [modal, setModal] = useState<Modal | null>(null);
  const [selectedType, setSelectedType] = useState<TrainingType>("групові");
  const [selectedTime, setSelectedTime] = useState<"19:00" | "20:00">("19:00");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fetchMonth = useCallback(async (month: string) => {
    try {
      const data = await api.getCalendar(month);
      setSlots(data);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) router.push("/admin/login");
    }
  }, [router]);

  const handleDatesSet = useCallback((arg: DatesSetInfo) => {
    const mid = new Date((arg.start.getTime() + arg.end.getTime()) / 2);
    const month = `${mid.getFullYear()}-${String(mid.getMonth() + 1).padStart(2, "0")}`;
    if (month !== currentMonth) {
      setCurrentMonth(month);
      fetchMonth(month);
    }
  }, [currentMonth, fetchMonth]);

  const events = slots.map((s) => {
    const colors = TYPE_COLORS[s.trainingType];
    return {
      id: s.slotId,
      title: `${s.slotTime} · ${TYPE_LABELS[s.trainingType]} · ${s.bookedCount}/${s.capacity}`,
      date: s.localDate,
      backgroundColor: colors.bg,
      borderColor: colors.border,
      textColor: colors.text,
      extendedProps: { slot: s },
    };
  });

  const openAddModal = (date: string) => {
    setSelectedType("групові");
    setSelectedTime("19:00");
    setError("");
    setModal({ date, existingSlot: null });
  };

  const openEditModal = (slot: CalendarSlot) => {
    setSelectedType(slot.trainingType);
    setSelectedTime(slot.slotTime);
    setError("");
    setModal({ date: slot.localDate, existingSlot: slot });
  };

  const handleEventClick = (arg: EventClickInfo) => {
    const slot = arg.event.extendedProps.slot as CalendarSlot;
    openEditModal(slot);
  };

  const handleDateClick = (arg: DateClickInfo) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const clicked = new Date(arg.dateStr + "T12:00:00");
    if (clicked < today) return;
    openAddModal(arg.dateStr);
  };

  const handleSave = async () => {
    if (!modal) return;
    setSaving(true);
    setError("");
    try {
      if (selectedType === "групові") {
        // групові = обидва слоти
        await Promise.all(
          SLOT_TIMES.map((t) => api.upsertCalendarSlot(modal.date, t, selectedType))
        );
      } else {
        await api.upsertCalendarSlot(modal.date, selectedTime, selectedType);
      }
      await fetchMonth(currentMonth);
      setModal(null);
    } catch {
      setError("Помилка збереження. Спробуйте ще раз.");
    } finally {
      setSaving(false);
    }
  };

  const handleCancelSlot = async () => {
    if (!modal?.existingSlot) return;
    setSaving(true);
    setError("");
    try {
      await api.cancelSlot(modal.existingSlot.slotId);
      await fetchMonth(currentMonth);
      setModal(null);
    } catch {
      setError("Помилка. Спробуйте ще раз.");
    } finally {
      setSaving(false);
    }
  };

  const isEditing = !!modal?.existingSlot;

  return (
    <PageLayout variant="top" action={
      <Link href="/admin" className="text-muted text-sm hover:text-body transition-colors">
        ← Назад
      </Link>
    }>
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

      <style>{`
        .fc { --fc-border-color: #1a2040; --fc-today-bg-color: rgba(147,210,60,0.06); --fc-page-bg-color: transparent; color: #c8d4ec; font-size: 0.8125rem; }
        .fc .fc-toolbar-title { font-size: 0.8125rem; font-weight: 600; color: #d8e4f8; }
        .fc .fc-toolbar { align-items: center; }
        .fc .fc-toolbar-chunk { display: flex; align-items: center; }
        .fc .fc-button { background: transparent; border-color: #1a2040; color: #c8d4ec; font-size: 0.75rem; padding: 0.25rem 0.625rem; line-height: 1; }
        .fc .fc-button:hover { background: #1a2040; color: #d8e4f8; border-color: #1a2040; }
        .fc .fc-button:focus { box-shadow: none; }
        .fc .fc-button-primary:not(:disabled).fc-button-active, .fc .fc-button-primary:not(:disabled):active { background: #1a2040; border-color: #93d23c; box-shadow: none; }
        .fc .fc-col-header-cell { background: #0d1019; }
        .fc .fc-col-header-cell-cushion { color: #4a5a80; font-weight: 500; text-transform: uppercase; font-size: 0.6875rem; letter-spacing: 0.05em; }
        .fc .fc-daygrid-day-number { color: #c8d4ec; font-size: 0.75rem; }
        .fc .fc-day-other .fc-daygrid-day-number { color: #1a2040; }
        .fc .fc-day-today .fc-daygrid-day-number { color: #93d23c; font-weight: 700; }
        .fc .fc-event { cursor: pointer; border-width: 1px; border-radius: 4px; padding: 1px 4px; --fc-event-bg-color: transparent; --fc-event-border-color: transparent; }
        .fc .fc-event-title { font-size: 0.6875rem; font-weight: 500; }
        .fc .fc-daygrid-day { cursor: pointer; }
        .fc .fc-daygrid-day:hover { background: rgba(26,32,64,0.4); }
        .fc th, .fc td { border-color: #1a2040; }
        .fc .fc-scrollgrid { border-color: #1a2040; }
        .fc .fc-scrollgrid-sync-table { border-color: #1a2040; }
      `}</style>

      <div className="rounded-xl border border-line p-3 overflow-hidden">
        {!mounted ? <div className="h-64 flex items-center justify-center text-muted text-sm">Завантаження...</div> : <FullCalendar
          plugins={[classicThemePlugin, dayGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          locale={ukLocale}
          height="auto"
          events={events}
          datesSet={handleDatesSet}
          eventClick={handleEventClick}
          dateClick={handleDateClick}
          headerToolbar={{ left: "prev,next", center: "title", right: "" }}
          fixedWeekCount={false}
        />}
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative w-full max-w-sm bg-surface border border-line rounded-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <p className="text-muted text-xs uppercase tracking-wide mb-1">
                {new Date(modal.date + "T12:00:00").toLocaleDateString("uk-UA", { weekday: "long", day: "numeric", month: "long" })}
              </p>
              <p className="font-geologica font-semibold text-heading">
                {isEditing ? `Редагувати ${modal.existingSlot!.slotTime}` : "Додати тренування"}
              </p>
            </div>

            {/* Тип тренування */}
            <div className="flex flex-col space-y-2">
              {TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedType(t)}
                  className={`flex items-center justify-between px-4 py-3 rounded-xl border text-sm transition-colors ${selectedType === t ? "" : "border-line"}`}
                  style={selectedType === t ? { borderColor: TYPE_COLORS[t].border, backgroundColor: TYPE_COLORS[t].bg, color: TYPE_COLORS[t].text } : {}}
                >
                  <span>{TYPE_LABELS[t]}</span>
                  {selectedType === t && <span>✓</span>}
                </button>
              ))}
            </div>

            {/* Час — тільки для не-групових і тільки при додаванні нового */}
            {!isEditing && selectedType !== "групові" && (
              <div>
                <p className="text-muted text-xs mb-2 uppercase tracking-wide">Час</p>
                <div className="flex space-x-2">
                  {SLOT_TIMES.map((t) => (
                    <button
                      key={t}
                      onClick={() => setSelectedTime(t)}
                      className={`flex-1 py-2 rounded-lg border text-sm transition-colors ${selectedTime === t ? "border-teal bg-teal/10 text-teal" : "border-line text-muted"}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <p className="text-muted text-xs mt-2">Групові займають обидва слоти автоматично</p>
              </div>
            )}

            {!isEditing && selectedType === "групові" && (
              <p className="text-muted text-xs">Буде створено слоти 19:00 і 20:00</p>
            )}

            {error && <p className="text-danger text-sm">{error}</p>}

            <div className="flex flex-col space-y-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary w-full py-3 rounded-xl text-sm font-medium transition-colors disabled:opacity-60"
              >
                {saving ? "Зачекайте..." : "Зберегти"}
              </button>
              {isEditing && (
                <button
                  onClick={handleCancelSlot}
                  disabled={saving}
                  className="btn-ghost hover-danger w-full py-3 rounded-xl border text-sm transition-colors disabled:opacity-60"
                >
                  Скасувати слот {modal.existingSlot!.slotTime}
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
