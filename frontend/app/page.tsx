"use client";
import { useEffect, useRef, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ScheduleNext } from "@/lib/api";
import { SlotCard } from "@/components/SlotCard";
import DemoControls from "@/components/DemoControls";

function formatLocalDate(localDate: string): string {
  const date = new Date(localDate + "T12:00:00");
  return new Intl.DateTimeFormat("uk-UA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Kyiv",
  }).format(date);
}

export default function SchedulePage() {
  const router = useRouter();
  const [schedule, setSchedule] = useState<ScheduleNext | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutateError, setMutateError] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const authedRef = useRef(false);

  const fetchSchedule = useCallback(async () => {
    try {
      const data = await api.getScheduleNext();
      setSchedule(data);
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 401 && !authedRef.current) {
        router.push("/login");
        throw err;
      }
    }
  }, [router]);

  const startPolling = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchSchedule, 5_000);
  }, [fetchSchedule]);

  useEffect(() => {
    fetchSchedule().then(() => {
      authedRef.current = true;
      setLoading(false);
      startPolling();
    }).catch(() => {});

    const onVisibility = () => {
      if (document.hidden) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = null;
      } else {
        fetchSchedule();
        startPolling();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchSchedule, startPolling]);

  const handleMutate = async (fn: () => Promise<unknown>) => {
    setMutateError("");
    try {
      await fn();
      await fetchSchedule();
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "";
      const msg =
        raw.includes("Slot is full") ? "Місць вже немає, хтось встиг раніше" :
        raw.includes("Booking opens at 14:00") ? "Запис відкривається о 14:00" :
        raw.includes("Booking window has closed") ? "Час запису вже минув" :
        raw.includes("already have an active booking") ? "Ви вже записані на цей день" :
        raw.includes("Slot is cancelled") ? "Цей час скасовано тренером" :
        raw || "Помилка. Спробуйте ще раз.";
      setMutateError(msg);
    }
  };

  const handleLogout = async () => {
    await api.logout().catch(() => {});
    router.push("/login");
  };

  if (loading) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <p className="text-muted text-sm">Завантаження...</p>
      </main>
    );
  }

  if (!schedule) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <p className="text-danger text-sm">Не вдалося завантажити розклад.</p>
      </main>
    );
  }

  const now = new Date(schedule.serverTime);
  const openAt = new Date(schedule.bookingOpenAt);
  const closeAt = new Date(schedule.bookingCloseAt);
  const beforeWindow = now < openAt;
  const afterWindow = now >= closeAt;

  return (
    <>
    <main className={`flex-1 px-5 ${schedule.isDemoMode ? "pb-28" : "pb-12"}`}>
      <div className="w-full max-w-xl mx-auto pt-8 sm:pt-12">
        <div className="flex items-start justify-between mb-1">
          <h1 className="font-geologica font-semibold text-2xl sm:text-3xl text-heading">
            Наступне тренування
          </h1>
          <button
            onClick={handleLogout}
            className="text-muted text-sm hover:text-body transition-colors mt-1 ml-4 shrink-0"
          >
            Вийти
          </button>
        </div>

        <p className="text-muted text-sm mb-4 capitalize">
          {formatLocalDate(schedule.localDate)}
        </p>

        {schedule.announcement && (
          <div className="bg-teal/8 border border-teal/20 rounded-xl px-4 py-3 mb-5 text-sm text-body">
            {schedule.announcement}
          </div>
        )}

        {beforeWindow && (
          <div className="bg-surface rounded-xl px-4 py-3 mb-6 text-sm text-body">
            Запис відкриється о{" "}
            <span className="font-medium text-heading">14:00</span>
          </div>
        )}

        {afterWindow && (
          <div className="bg-surface rounded-xl px-4 py-3 mb-6 text-sm text-body">
            Запис на цей день закрито
          </div>
        )}

        <div className="flex flex-col space-y-4">
          {schedule.slots.map((slot) => (
            <SlotCard
              key={slot.id}
              slot={slot}
              allSlots={schedule.slots}
              bookingWindowOpen={schedule.bookingWindowOpen}
              afterWindow={afterWindow}
              onMutate={handleMutate}
              onRefresh={fetchSchedule}
            />
          ))}
        </div>

        {mutateError && (
          <p className="text-danger text-sm mt-4 text-center">{mutateError}</p>
        )}
      </div>
    </main>
    {schedule.isDemoMode && <DemoControls onRefresh={fetchSchedule} />}
    </>
  );
}