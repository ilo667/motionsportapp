"use client";
import { useEffect, useRef, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { api, AdminSchedule } from "@/lib/api";
import { AdminSlotCard } from "@/components/AdminSlotCard";

function formatLocalDate(localDate: string): string {
  const date = new Date(localDate + "T12:00:00");
  return new Intl.DateTimeFormat("uk-UA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Kyiv",
  }).format(date);
}

export default function AdminPage() {
  const router = useRouter();
  const [schedule, setSchedule] = useState<AdminSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutateError, setMutateError] = useState("");
  const [confirmCancelDay, setConfirmCancelDay] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const authedRef = useRef(false);

  const fetchSchedule = useCallback(async () => {
    try {
      const data = await api.getAdminSchedule();
      setSchedule(data);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if ((status === 401 || status === 403) && !authedRef.current) {
        router.push("/admin/login");
      }
    }
  }, [router]);

  const startPolling = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchSchedule, 15_000);
  }, [fetchSchedule]);

  useEffect(() => {
    fetchSchedule().then(() => {
      authedRef.current = true;
      setLoading(false);
      startPolling();
    });

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
      const msg = err instanceof Error ? err.message : "Помилка. Спробуйте ще раз.";
      setMutateError(msg);
    }
  };

  const handleLogout = async () => {
    await api.logout().catch(() => {});
    router.push("/admin/login");
  };

  const handleCancelDay = async () => {
    if (!schedule) return;
    setConfirmCancelDay(false);
    await handleMutate(() => api.cancelTrainingDay(schedule.localDate));
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
  const closeAt = new Date(schedule.bookingCloseAt);
  const afterWindow = now >= closeAt;

  return (
    <main className="flex-1 px-[19px] pb-12">
      <div className="w-full max-w-[600px] mx-auto pt-[32px] sm:pt-[48px]">
        <div className="flex items-start justify-between mb-1">
          <h1 className="font-geologica font-semibold text-[24px] sm:text-[32px] text-heading">
            Панель тренера
          </h1>
          <button
            onClick={handleLogout}
            className="text-muted text-sm hover:text-body transition-colors mt-1 ml-4 shrink-0"
          >
            Вийти
          </button>
        </div>

        <p className="text-muted text-sm mb-1 capitalize">
          {formatLocalDate(schedule.localDate)}
        </p>

        <div className="flex items-center space-x-2 mb-6">
          {schedule.status === "CANCELLED" ? (
            <span className="text-xs text-danger bg-danger/10 border border-danger/30 rounded-full px-2 py-0.5">
              День скасовано
            </span>
          ) : schedule.bookingWindowOpen ? (
            <span className="text-xs text-teal bg-teal/10 border border-teal/30 rounded-full px-2 py-0.5">
              Запис відкрито
            </span>
          ) : afterWindow ? (
            <span className="text-xs text-muted bg-surface border border-line rounded-full px-2 py-0.5">
              Запис закрито
            </span>
          ) : (
            <span className="text-xs text-muted bg-surface border border-line rounded-full px-2 py-0.5">
              До 14:00
            </span>
          )}
        </div>

        <div className="grid gap-4 mb-6">
          {schedule.slots.map((slot) => (
            <AdminSlotCard key={slot.id} slot={slot} onMutate={handleMutate} />
          ))}
        </div>

        {mutateError && (
          <p className="text-danger text-sm mb-4 text-center">{mutateError}</p>
        )}

        {schedule.status !== "CANCELLED" && (
          <div className="border-t border-line pt-5">
            <p className="text-muted text-xs mb-3 uppercase tracking-wide font-medium">
              Керування днем
            </p>
            {!confirmCancelDay ? (
              <button
                onClick={() => setConfirmCancelDay(true)}
                className="w-full py-3 rounded-[8px] border border-line text-muted hover:border-danger hover:text-danger text-sm transition-colors"
              >
                Скасувати весь день
              </button>
            ) : (
              <div className="rounded-[8px] border border-danger bg-danger/5 p-4 space-y-3">
                <p className="text-danger text-sm">
                  Скасувати тренування {formatLocalDate(schedule.localDate)}? Всі записи буде відмінено.
                </p>
                <div className="flex space-x-2">
                  <button
                    onClick={handleCancelDay}
                    className="flex-1 py-2.5 rounded-[6px] bg-danger text-white text-sm font-medium hover:opacity-90 transition-colors"
                  >
                    Скасувати день
                  </button>
                  <button
                    onClick={() => setConfirmCancelDay(false)}
                    className="flex-1 py-2.5 rounded-[6px] border border-line text-muted text-sm hover:bg-surface transition-colors"
                  >
                    Ні
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}