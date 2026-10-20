"use client";
import { useEffect, useRef, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ScheduleNext } from "@/lib/api";
import { SlotCard } from "@/components/SlotCard";
import { GymLoader } from "@/components/GymLoader";
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
  const [authed, setAuthed] = useState<boolean | null>(null);
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
        try { localStorage.removeItem('mg_authed'); } catch {}
        setAuthed(false);
        setLoading(false);
        throw err;
      }
    }
  }, []);

  const startPolling = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchSchedule, 5_000);
  }, [fetchSchedule]);

  useEffect(() => {
    const hasFlag = (() => {
      try { return localStorage.getItem('mg_authed') === '1'; } catch { return true; }
    })();

    if (!hasFlag) {
      setAuthed(false);
      setLoading(false);
      return;
    }

    fetchSchedule().then(() => {
      authedRef.current = true;
      setAuthed(true);
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
    try { localStorage.removeItem('mg_authed'); } catch {}
    router.push("/login");
  };

  if (authed === false) {
    return (
      <div className="flex flex-col items-center text-center">
          <h1 className="font-geologica font-semibold text-display text-heading mb-3">
            Motion Gym
          </h1>
          <div className="flex flex-col w-full max-w-xs gap-3 mt-10">
            <Link href="/login" className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors text-center">
              Увійти як клієнт
            </Link>
            <Link href="/admin/login" className="btn-secondary w-full py-4 rounded-lg border font-medium text-sm transition-colors text-center">
              Вхід для тренера
            </Link>
          </div>
      </div>
    );
  }

  if (loading) {
    return <GymLoader />;
  }

  if (!schedule) {
    return <p className="text-danger text-sm">Не вдалося завантажити розклад.</p>;
  }

  const now = new Date(schedule.serverTime);
  const openAt = new Date(schedule.bookingOpenAt);
  const closeAt = new Date(schedule.bookingCloseAt);
  const beforeWindow = now < openAt;
  const afterWindow = now >= closeAt;

  return (
    <>
      <div className="flex items-start justify-between mb-1">
          <h1 className="font-geologica font-semibold text-title sm:text-display text-heading">
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

        <div className="flex items-center mb-6">
          {beforeWindow ? (
            <span className="text-xs text-muted bg-surface border border-line rounded-full px-3 py-1">
              До 14:00
            </span>
          ) : afterWindow ? (
            <span className="text-xs text-muted bg-surface border border-line rounded-full px-3 py-1">
              Запис закрито
            </span>
          ) : (
            <span className="text-xs font-semibold uppercase tracking-wide text-teal bg-teal/10 border border-teal/30 rounded-full px-3 py-1 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-teal shrink-0"></span>
              Запис відкрито
            </span>
          )}
        </div>

        <div className="rounded-2xl border border-line p-3 flex flex-col space-y-3">
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
      {schedule.isDemoMode && <DemoControls onRefresh={fetchSchedule} />}
    </>
  );
}