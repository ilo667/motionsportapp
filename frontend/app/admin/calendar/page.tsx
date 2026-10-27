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
import { api, AdminMember, CalendarSlot, TrainerSchedule, TrainingType } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { useIsClient } from "@/lib/clientStore";
import { TYPE_COLORS, TYPE_LABEL_PLURAL } from "@/lib/trainingTypes";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { AddSlotModal } from "./AddSlotModal";
import { EditSlotModal } from "./EditSlotModal";
import { TYPES, weekdayOf } from "./slotForm";
import { toAdminLogin } from "@/lib/adminAuth";

// Short labels for calendar events — full names don't fit a day column
const TYPE_SHORT: Record<TrainingType, string> = {
  групові: "Груп.",
  персональні: "Перс.",
  спліт: "Спліт",
};

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

// The modal open now: «Додати тренування» on a day (time prefilled from the week view), or a clicked training
type OpenModal = { mode: "add"; date: string; time: string } | { mode: "edit"; slot: CalendarSlot };

export default function CalendarPage() {
  const router = useRouter();
  // FullCalendar renders in the browser only
  const mounted = useIsClient();
  const [slots, setSlots] = useState<CalendarSlot[]>([]);
  const [members, setMembers] = useState<AdminMember[]>([]);
  // Months covering the visible range ("2026-10,2026-11"): a week can span two months
  const [visibleMonths, setVisibleMonths] = useState("");

  const [modal, setModal] = useState<OpenModal | null>(null);

  const handleAuthError = useCallback(
    (err: unknown) => {
      toAdminLogin(err, router);
    },
    [router],
  );

  // «Розклад групових»: the opening time (a group training before it can't be booked, warned in the modal),
  // which trainings repeat weekly (↻), and where «Щотижня» adds a time
  const [schedule, setSchedule] = useState<TrainerSchedule | null>(null);
  useEffect(() => {
    api
      .getMySchedule()
      .then(setSchedule)
      .catch(() => {});
  }, []);

  // A group training at a weekday and time of the schedule, created by itself while auto-creation is on
  const repeatsWeekly = (s: CalendarSlot) =>
    s.trainingType === "групові" &&
    !!schedule?.autoCreate &&
    schedule.times.some((t) => t.weekday === weekdayOf(s.localDate) && t.slotTime === s.slotTime);

  useEffect(() => {
    api.getMembers().then(setMembers).catch(handleAuthError);
  }, [handleAuthError]);

  const fetchMonths = useCallback(
    async (months: string) => {
      if (!months) return;
      try {
        const data = (await Promise.all(months.split(",").map((m) => api.getCalendar(m)))).flat();
        setSlots(data);
        return data;
      } catch (err: unknown) {
        handleAuthError(err);
      }
    },
    [handleAuthError],
  );

  const handleDatesSet = useCallback(
    (arg: DatesSetInfo) => {
      // Every month touched by the visible range: a week can span 2 months, the month view 3 (with edge days)
      const lastVisible = new Date(arg.end.getTime() - 1); // end is exclusive
      const list: string[] = [];
      for (
        let d = new Date(arg.start.getFullYear(), arg.start.getMonth(), 1);
        d <= lastVisible;
        d.setMonth(d.getMonth() + 1)
      ) {
        list.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
      }
      const months = list.join(",");
      if (months !== visibleMonths) {
        setVisibleMonths(months);
        fetchMonths(months);
      }
    },
    [visibleMonths, fetchMonths],
  );

  const events = slots.map((s) => {
    const start = `${s.localDate}T${s.slotTime}:00`;
    const end = new Date(new Date(start).getTime() + 60 * 60 * 1000);
    const colors = TYPE_COLORS[s.trainingType];
    // Group: how full it is. Assigned: who has a package ("Спліт · Катя ✓, Оля")
    const detail =
      s.trainingType === "групові"
        ? `${s.bookedCount}/${s.capacity}`
        : s.members
            .map((m) => `${m.displayName}${m.booked && (m.spent || m.packageLeft > 0) ? " ✓" : ""}`)
            .join(", ") || "без людей";
    return {
      id: s.slotId,
      title: `${repeatsWeekly(s) ? "↻ " : ""}${TYPE_SHORT[s.trainingType]} · ${detail}`,
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

  const openEditModal = (slot: CalendarSlot) => {
    setModal({ mode: "edit", slot });
    // The calendar was loaded earlier: a member may have cancelled or been marked since, so the modal shows the
    // training as it is now (its cancellations are loaded fresh by the modal)
    fetchMonths(visibleMonths).then((data) => {
      const fresh = data?.find((s) => s.slotId === slot.slotId);
      if (fresh)
        setModal((m) => (m?.mode === "edit" && m.slot.slotId === slot.slotId ? { mode: "edit", slot: fresh } : m));
    });
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
    setModal({ mode: "add", date, time: arg.dateStr.slice(11, 16) });
  };

  // A modal saved: the calendar reloads, the modal closes
  const done = async () => {
    await fetchMonths(visibleMonths);
    setModal(null);
  };

  return (
    <PageLayout variant="top" action={<AdminMenu />}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">Календар</h1>

      <div className="flex items-center -m-1 flex-wrap mb-4">
        {TYPES.map((t) => (
          <span
            key={t}
            className="m-1 flex items-center text-xs px-2 py-1 rounded-full border"
            style={{
              borderColor: TYPE_COLORS[t].border,
              color: TYPE_COLORS[t].text,
              backgroundColor: TYPE_COLORS[t].bg,
            }}
          >
            {TYPE_LABEL_PLURAL[t]}
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
        {!mounted ? (
          <div className="h-64 flex items-center justify-center text-muted text-sm">Завантаження...</div>
        ) : (
          <FullCalendar
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
          />
        )}
      </div>

      {modal?.mode === "add" && (
        <AddSlotModal
          date={modal.date}
          initialTime={modal.time}
          schedule={schedule}
          onScheduleSaved={setSchedule}
          members={members}
          onDone={done}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.mode === "edit" && (
        <EditSlotModal
          key={modal.slot.slotId}
          slot={modal.slot}
          repeatsWeekly={repeatsWeekly(modal.slot)}
          members={members}
          onDone={done}
          onClose={() => setModal(null)}
        />
      )}
    </PageLayout>
  );
}
