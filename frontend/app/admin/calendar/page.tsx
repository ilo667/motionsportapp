"use client";
import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import ukLocale from "@fullcalendar/react/locales/uk";
import type { DatesSetInfo, EventClickInfo, DateClickInfo } from "@fullcalendar/react";
import { api, CalendarDay, TrainingType } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";

const TYPE_COLORS: Record<TrainingType, { bg: string; border: string; text: string }> = {
  групові:       { bg: "#78350f", border: "#d97706", text: "#fde68a" },
  індивідуальні: { bg: "#14532d", border: "#93d23c", text: "#bbf7d0" },
  спліт:         { bg: "#7c2d12", border: "#fb923c", text: "#fed7aa" },
};

const TYPE_LABELS: Record<TrainingType, string> = {
  групові: "Групові",
  індивідуальні: "Індивідуальні",
  спліт: "Спліт",
};

const TYPES: TrainingType[] = ["групові", "індивідуальні", "спліт"];

interface Modal {
  date: string;
  existing: CalendarDay | null;
}

export default function CalendarPage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [days, setDays] = useState<CalendarDay[]>([]);
  const [currentMonth, setCurrentMonth] = useState("");

  useEffect(() => { setMounted(true); }, []);
  const [modal, setModal] = useState<Modal | null>(null);
  const [selectedType, setSelectedType] = useState<TrainingType>("групові");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fetchMonth = useCallback(async (month: string) => {
    try {
      const data = await api.getCalendar(month);
      setDays(data);
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

  const daysMap = Object.fromEntries(days.map((d) => [d.localDate, d]));

  const events = days
    .filter((d) => d.status === "SCHEDULED")
    .map((d) => {
      const colors = TYPE_COLORS[d.trainingType];
      return {
        id: d.localDate,
        title: `${TYPE_LABELS[d.trainingType]}${d.totalCapacity > 0 ? ` · ${d.bookedCount}/${d.totalCapacity}` : ""}`,
        date: d.localDate,
        backgroundColor: colors.bg,
        borderColor: colors.border,
        textColor: colors.text,
      };
    });

  const openModal = (date: string) => {
    const existing = daysMap[date] ?? null;
    setSelectedType(existing?.trainingType ?? "групові");
    setError("");
    setModal({ date, existing });
  };

  const handleEventClick = (arg: EventClickInfo) => {
    openModal(arg.event.startStr);
  };

  const handleDateClick = (arg: DateClickInfo) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const clicked = new Date(arg.dateStr);
    if (clicked < today) return;
    openModal(arg.dateStr);
  };

  const handleSave = async () => {
    if (!modal) return;
    setSaving(true);
    setError("");
    try {
      await api.upsertTrainingDay(modal.date, {
        status: "SCHEDULED",
        trainingType: selectedType,
        isException: !isRegularDay(modal.date),
      });
      await fetchMonth(currentMonth);
      setModal(null);
    } catch {
      setError("Помилка збереження. Спробуйте ще раз.");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async () => {
    if (!modal) return;
    setSaving(true);
    setError("");
    try {
      await api.upsertTrainingDay(modal.date, { status: "CANCELLED", isException: true });
      await fetchMonth(currentMonth);
      setModal(null);
    } catch {
      setError("Помилка. Спробуйте ще раз.");
    } finally {
      setSaving(false);
    }
  };

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
        .fc .fc-toolbar-title { font-size: 1rem; font-weight: 600; color: #d8e4f8; }
        .fc .fc-button { background: #0d1019; border-color: #1a2040; color: #c8d4ec; font-size: 0.75rem; padding: 0.25rem 0.625rem; }
        .fc .fc-button:hover { background: #1a2040; color: #d8e4f8; }
        .fc .fc-button-primary:not(:disabled).fc-button-active, .fc .fc-button-primary:not(:disabled):active { background: #1a2040; border-color: #93d23c; }
        .fc .fc-col-header-cell { background: #0d1019; }
        .fc .fc-col-header-cell-cushion { color: #4a5a80; font-weight: 500; text-transform: uppercase; font-size: 0.6875rem; letter-spacing: 0.05em; }
        .fc .fc-daygrid-day-number { color: #c8d4ec; font-size: 0.75rem; }
        .fc .fc-day-other .fc-daygrid-day-number { color: #1a2040; }
        .fc .fc-day-today .fc-daygrid-day-number { color: #93d23c; font-weight: 700; }
        .fc .fc-event { cursor: pointer; border-width: 1px; border-radius: 4px; padding: 1px 4px; }
        .fc .fc-event-title { font-size: 0.6875rem; font-weight: 500; }
        .fc .fc-daygrid-day { cursor: pointer; }
        .fc .fc-daygrid-day:hover { background: rgba(26,32,64,0.4); }
        .fc th, .fc td { border-color: #1a2040; }
        .fc .fc-scrollgrid { border-color: #1a2040; }
        .fc .fc-scrollgrid-sync-table { border-color: #1a2040; }
      `}</style>

      <div className="rounded-xl border border-line p-3 overflow-hidden">
        {!mounted ? <div className="h-64 flex items-center justify-center text-muted text-sm">Завантаження...</div> : <FullCalendar
          plugins={[dayGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          locale={ukLocale}
          height="auto"
          events={events}
          datesSet={handleDatesSet}
          eventClick={handleEventClick}
          dateClick={handleDateClick}
          headerToolbar={{ left: "prev", center: "title", right: "next" }}
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
                {modal.existing?.status === "SCHEDULED" ? "Редагувати тренування" : "Додати тренування"}
              </p>
            </div>

            <div className="flex flex-col space-y-2">
              {TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedType(t)}
                  className={`flex items-center justify-between px-4 py-3 rounded-xl border text-sm transition-colors ${selectedType === t ? "border-opacity-100" : "border-line"}`}
                  style={selectedType === t ? { borderColor: TYPE_COLORS[t].border, backgroundColor: TYPE_COLORS[t].bg, color: TYPE_COLORS[t].text } : {}}
                >
                  <span>{TYPE_LABELS[t]}</span>
                  {selectedType === t && <span>✓</span>}
                </button>
              ))}
            </div>

            {error && <p className="text-danger text-sm">{error}</p>}

            <div className="flex flex-col space-y-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary w-full py-3 rounded-xl text-sm font-medium transition-colors disabled:opacity-60"
              >
                {saving ? "Зачекайте..." : "Зберегти"}
              </button>
              {modal.existing?.status === "SCHEDULED" && (
                <button
                  onClick={handleCancel}
                  disabled={saving}
                  className="btn-ghost hover-danger w-full py-3 rounded-xl border text-sm transition-colors disabled:opacity-60"
                >
                  Скасувати день
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

function isRegularDay(dateStr: string): boolean {
  const day = new Date(dateStr + "T12:00:00").getDay();
  return day === 2 || day === 4; // вівторок або четвер
}