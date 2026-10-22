"use client";
import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
  // Months covering the visible range ("2026-10,2026-11"): a week can span two months
  const [visibleMonths, setVisibleMonths] = useState("");

  useEffect(() => { setMounted(true); }, []);
  const [modal, setModal] = useState<Modal | null>(null);
  const [selectedType, setSelectedType] = useState<TrainingType>("групові");
  const [selectedTime, setSelectedTime] = useState<"19:00" | "20:00">("19:00");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fetchMonths = useCallback(async (months: string) => {
    if (!months) return;
    try {
      const data = await Promise.all(months.split(",").map((m) => api.getCalendar(m)));
      setSlots(data.flat());
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) router.push("/admin/login");
    }
  }, [router]);

  const handleDatesSet = useCallback((arg: DatesSetInfo) => {
    // Every month touched by the visible range: a week can span 2 months, the month view 3 (with edge days)
    const lastVisible = new Date(arg.end.getTime() - 1); // end is exclusive
    const list: string[] = [];
    for (let d = new Date(arg.start.getFullYear(), arg.start.getMonth(), 1); d <= lastVisible; d.setMonth(d.getMonth() + 1)) {
      list.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    const months = list.join(",");
    if (months !== visibleMonths) {
      setVisibleMonths(months);
      fetchMonths(months);
    }
  }, [visibleMonths, fetchMonths]);

  const events = slots.map((s) => {
    const colors = TYPE_COLORS[s.trainingType];
    return {
      id: s.slotId,
      title: `${TYPE_LABELS[s.trainingType]} · ${s.bookedCount}/${s.capacity}`,
      // Timed events (1 h) so the week-with-hours view places them on their hour; the time is shown by FullCalendar
      start: `${s.localDate}T${s.slotTime}:00`,
      end: `${s.localDate}T${s.slotTime === "19:00" ? "20:00" : "21:00"}:00`,
      // v7 names (v6 backgroundColor/borderColor/textColor are ignored)
      color: colors.bg,
      contrastColor: colors.text,
      extendedProps: { slot: s },
    };
  });

  const openAddModal = (date: string, time: "19:00" | "20:00" = "19:00") => {
    setSelectedType("групові");
    setSelectedTime(time);
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
    // Month view gives "YYYY-MM-DD", week-with-hours gives "YYYY-MM-DDTHH:mm:ss+03:00"
    const date = arg.dateStr.slice(0, 10);
    const clicked = new Date(date + "T12:00:00");
    if (clicked < today) return;
    openAddModal(date, arg.dateStr.slice(11, 13) === "20" ? "20:00" : "19:00");
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
      await fetchMonths(visibleMonths);
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
      await fetchMonths(visibleMonths);
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
          headerToolbar={{ left: "prev,next", center: "title", right: "timeGridWeek,dayGridMonth" }}
          firstDay={1}
          slotMinTime="17:00:00"
          slotMaxTime="22:00:00"
          allDaySlot={false}
          eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
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
