"use client";
import { useEffect, useRef, useCallback, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ScheduleNext } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { SlotCard } from "@/components/SlotCard";
import { kyivTime } from "@/lib/kyivTime";
import { AssignedSlotCard } from "@/components/AssignedSlotCard";
import { noopSubscribe } from "@/lib/clientStore";
import { resyncExistingSubscription } from "@/lib/pushUtils";

function formatLocalDate(localDate: string): string {
  const date = new Date(localDate + "T12:00:00");
  return new Intl.DateTimeFormat("uk-UA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Kyiv",
  }).format(date);
}

// «24.11»: the last frozen day
function formatShortDate(localDate: string): string {
  const [, m, d] = localDate.split("-");
  return `${d}.${m}`;
}

const POLL_OPEN_MS = 5_000; // booking window open: seats change fast
const POLL_IDLE_MAX_MS = 5 * 60_000; // outside the window: safety refresh (missed timers, trainer changes)
const POLL_ERROR_MS = 30_000;

// Outside the booking window nothing changes except at bookingOpenAt / bookingCloseAt,
// so wake up exactly then (in server time, so a wrong phone clock doesn't matter) or after the safety interval
function nextPollDelay(data: ScheduleNext | undefined): number {
  if (!data) return POLL_ERROR_MS;
  if (data.bookingWindowOpen) return POLL_OPEN_MS;

  const serverNow = Date.parse(data.serverTime);
  // No group day in the calendar: nothing to wake up for except the safety refresh
  if (!data.bookingOpenAt || !data.bookingCloseAt) return POLL_IDLE_MAX_MS;
  const openAt = Date.parse(data.bookingOpenAt);
  const closeAt = Date.parse(data.bookingCloseAt);
  // Window should be open by now but server still says closed (clock skew) — retry soon
  if (serverNow >= openAt && serverNow < closeAt) return POLL_OPEN_MS;

  const nextEdge = [openAt, closeAt].filter((t) => t > serverNow).sort((a, b) => a - b)[0];
  const untilEdge = nextEdge ? nextEdge - serverNow + 1_000 : POLL_IDLE_MAX_MS;
  return Math.min(Math.max(untilEdge, 1_000), POLL_IDLE_MAX_MS);
}

// Set on login, cleared on logout / 401. Without it the page shows the landing and skips the API call
function readAuthFlag(): boolean {
  try {
    return localStorage.getItem("mg_authed") === "1";
  } catch {
    return true;
  }
}

export default function SchedulePage() {
  const router = useRouter();
  const [schedule, setSchedule] = useState<ScheduleNext | null>(null);
  // null on the server and during hydration, then the browser's flag
  const hasFlag = useSyncExternalStore<boolean | null>(noopSubscribe, readAuthFlag, () => null);
  // Result of the first schedule fetch (false = session expired)
  const [sessionOk, setAuthed] = useState<boolean | null>(null);
  const authed = hasFlag === false ? false : sessionOk;
  const [loading, setLoading] = useState(true);
  const [mutateError, setMutateError] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingRef = useRef(false);
  const fetchRef = useRef<(() => Promise<void>) | null>(null);

  const authedRef = useRef(false);

  const stopPolling = useCallback(() => {
    pollingRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // Every refresh (poll, mutation) reschedules the next one from fresh data
  const fetchSchedule = useCallback(async () => {
    let data: ScheduleNext | undefined;
    try {
      data = await api.getScheduleNext();
      setSchedule(data);
    } catch (err: unknown) {
      // Signed in as a trainer: the schedule here is the members', the trainer's is in the panel
      if ((err as { status?: number }).status === 403) {
        router.replace("/admin");
        throw err;
      }
      if ((err as { status?: number }).status === 401 && !authedRef.current) {
        try {
          localStorage.removeItem("mg_authed");
        } catch {}
        setAuthed(false);
        setLoading(false);
        throw err;
      }
    }
    if (pollingRef.current) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        fetchRef.current?.().catch(() => {});
      }, nextPollDelay(data));
    }
  }, [router]);

  useEffect(() => {
    fetchRef.current = fetchSchedule;
  }, [fetchSchedule]);

  const startPolling = useCallback(() => {
    pollingRef.current = true;
    fetchSchedule().catch(() => {});
  }, [fetchSchedule]);

  useEffect(() => {
    if (hasFlag !== true) return;

    pollingRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchSchedule is async: state is set after the await, not synchronously
    fetchSchedule()
      .then(() => {
        authedRef.current = true;
        setAuthed(true);
        setLoading(false);
        // Signed in: this browser's pushes belong to this member again (logout switched them off)
        resyncExistingSubscription();
      })
      .catch(() => stopPolling());

    const onVisibility = () => {
      if (document.hidden) stopPolling();
      else startPolling();
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hasFlag, fetchSchedule, startPolling, stopPolling]);

  const handleMutate = async (fn: () => Promise<unknown>) => {
    setMutateError("");
    try {
      await fn();
      await fetchSchedule();
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "";
      const msg = raw.includes("Slot is full")
        ? "Місць вже немає, хтось встиг раніше"
        : raw.includes("Booking is not open yet")
          ? "Запис ще не відкрився"
          : raw.includes("Booking window has closed")
            ? "Час запису вже минув"
            : raw.includes("already have an active booking")
              ? "Ви вже записані на цей день"
              : raw.includes("already booked this training")
                ? "Ви вже записані на це тренування"
                : raw.includes("already started")
                  ? "Тренування вже почалося"
                  : raw.includes("Slot is cancelled")
                    ? "Цей час скасовано тренером"
                    : raw.includes("Group pass required")
                      ? "Потрібен абонемент на групові: натисніть «Записатись» ще раз"
                      : raw.includes("Membership frozen")
                        ? "Абонемент заморожено"
                        : raw || "Помилка. Спробуйте ще раз.";
      setMutateError(msg);
    }
  };

  const handleLogout = async () => {
    await api.logout().catch(() => {});
    router.push("/login");
  };

  if (authed === null) {
    return <PageLayout loading />;
  }

  if (authed === false) {
    return (
      <PageLayout className="items-center text-center">
        <h1 className="font-geologica font-semibold text-display text-heading mb-3 uppercase">Motion Gym</h1>
        <div className="flex flex-col w-full max-w-xs space-y-3 mt-10">
          <Link
            href="/login"
            className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors text-center"
          >
            Увійти як клієнт
          </Link>
          <Link
            href="/admin/login"
            className="btn-secondary w-full py-4 rounded-lg border font-medium text-sm transition-colors text-center"
          >
            Вхід для тренера
          </Link>
        </div>
      </PageLayout>
    );
  }

  const scheduleAction = (
    <div className="flex items-center space-x-4">
      <Link href="/purchases" className="text-sm text-accent hover:underline">
        Мій абонемент
      </Link>
      <button onClick={handleLogout} className="text-muted text-sm hover:text-body transition-colors">
        Вийти
      </button>
    </div>
  );

  if (!loading && !schedule) {
    return (
      <PageLayout variant="top" action={scheduleAction}>
        <p className="text-danger text-sm">Не вдалося завантажити розклад.</p>
      </PageLayout>
    );
  }

  const now = schedule ? new Date(schedule.serverTime) : null;
  const openAt = schedule?.bookingOpenAt ? new Date(schedule.bookingOpenAt) : null;
  const closeAt = schedule?.bookingCloseAt ? new Date(schedule.bookingCloseAt) : null;
  const beforeWindow = now && openAt ? now < openAt : false;
  const afterWindow = now && closeAt ? now >= closeAt : false;

  return (
    <PageLayout variant="top" loading={loading} action={scheduleAction}>
      {schedule && (
        <>
          <h1 className="font-geologica font-semibold text-title sm:text-display text-heading mb-1 uppercase">
            Наступне тренування
          </h1>

          {schedule.frozenUntil && (
            <Link
              href="/purchases"
              className="block bg-warn-bg border border-warn-line rounded-xl px-4 py-3 mb-4 text-sm text-warn"
            >
              Абонемент заморожено до {formatShortDate(schedule.frozenUntil)} включно
            </Link>
          )}

          {!schedule.localDate ? (
            <p className="text-muted text-sm mb-4">Групових тренувань поки не заплановано.</p>
          ) : (
            <>
              <p className="text-muted text-sm mb-4 capitalize">{formatLocalDate(schedule.localDate)}</p>

              {schedule.announcement && (
                <div className="bg-teal/8 border border-teal/20 rounded-xl px-4 py-3 mb-5 text-sm text-body">
                  {schedule.announcement}
                </div>
              )}

              <div className="rounded-2xl border border-line p-3 flex flex-col space-y-3">
                <div className="flex items-center">
                  {beforeWindow ? (
                    <span className="text-xs text-muted bg-surface border border-line rounded-full px-3 py-1">
                      До {kyivTime(schedule.bookingOpenAt!)}
                    </span>
                  ) : afterWindow ? (
                    <span className="text-xs text-muted bg-surface border border-line rounded-full px-3 py-1">
                      Запис закрито
                    </span>
                  ) : (
                    <span className="text-sm font-semibold uppercase tracking-wide text-teal bg-teal/10 border border-teal/30 rounded-full px-4 py-1.5 flex items-center space-x-1.5">
                      <span className="relative flex w-3 h-3 shrink-0 items-center justify-center mr-1.5">
                        <span className="animate-ping absolute inline-flex h-3 w-3 rounded-full bg-teal opacity-75"></span>
                        <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-teal"></span>
                      </span>
                      Запис відкрито
                    </span>
                  )}
                </div>
                {schedule.slots.map((slot) => (
                  <SlotCard
                    key={slot.id}
                    slot={slot}
                    allSlots={schedule.slots}
                    groupPassLeft={schedule.groupPassLeft ?? 0}
                    bookingWindowOpen={schedule.bookingWindowOpen}
                    afterWindow={afterWindow}
                    bookingOpenAt={schedule.bookingOpenAt}
                    frozen={!!schedule.frozenUntil && schedule.localDate! <= schedule.frozenUntil}
                    onMutate={handleMutate}
                    onRefresh={fetchSchedule}
                  />
                ))}
              </div>
            </>
          )}

          {!!schedule.assignedSlots?.length && (
            <>
              <h2 className="font-geologica font-semibold text-heading uppercase mt-8 mb-3">Мої тренування</h2>
              <div className="flex flex-col space-y-3">
                {schedule.assignedSlots.map((slot) => (
                  <AssignedSlotCard key={slot.id} slot={slot} onMutate={handleMutate} />
                ))}
              </div>
            </>
          )}

          {mutateError && <p className="text-danger text-sm mt-4 text-center">{mutateError}</p>}
        </>
      )}
    </PageLayout>
  );
}
