"use client";
import { kyivTime } from "@/lib/kyivTime";
import { useEffect, useRef, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, AdminSchedule, Announcement, AnnouncementExample } from "@/lib/api";
import { SlotCard as AdminSlotCard } from "@/components/admin/SlotCard";
import { PageLayout } from "@/components/PageLayout";
import { PushSubscribeButton } from "@/components/PushSubscribeButton";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { errorText } from "@/lib/apiErrors";
import { longDay } from "@/lib/dates";
import { Badge } from "@/components/Badge";
import { toAdminLogin } from "@/lib/adminAuth";
import { AnnouncementSection } from "./AnnouncementSection";
import { CancelDayButton } from "./CancelDayButton";

export default function AdminPage() {
  const router = useRouter();
  const [schedule, setSchedule] = useState<AdminSchedule | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mutateError, setMutateError] = useState("");
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [examples, setExamples] = useState<AnnouncementExample[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const authedRef = useRef(false);

  const fetchSchedule = useCallback(async () => {
    try {
      const data = await api.getAdminSchedule();
      setSchedule(data);
      setLoadFailed(false);
      // null: this trainer has no upcoming trainings
      if (!data) return;
      const [ann, exs] = await Promise.all([
        api.getAnnouncement(data.localDate).catch(() => null),
        api.listAnnouncementExamples().catch(() => []),
      ]);
      setAnnouncement(ann);
      setExamples(exs);
    } catch (err: unknown) {
      // Signed out on the first load: the login; once the page has shown, a failed refresh only says so
      if (authedRef.current || !toAdminLogin(err, router)) setLoadFailed(true);
    }
  }, [router]);

  const startPolling = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchSchedule, 15_000);
  }, [fetchSchedule]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchSchedule is async: state is set after the await, not synchronously
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
      setMutateError(errorText(err));
    }
  };

  if (loading) {
    return <PageLayout variant="top" loading />;
  }

  if (!schedule) {
    return (
      <PageLayout variant="top" action={<AdminMenu />}>
        <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-3">
          Панель тренера
        </h1>
        {loadFailed ? (
          <p className="text-danger text-sm">Не вдалося завантажити розклад.</p>
        ) : (
          <p className="text-muted text-sm">
            Найближчих тренувань немає. Додайте їх у{" "}
            <Link href="/admin/calendar" className="text-accent hover:underline">
              календарі
            </Link>
            .
          </p>
        )}
      </PageLayout>
    );
  }

  const now = new Date(schedule.serverTime);
  const closeAt = new Date(schedule.bookingCloseAt);
  const afterWindow = now >= closeAt;
  // Booking is only for group trainings: a day with only personal / split ones shows no booking badge
  const hasGroup = schedule.slots.some((s) => s.trainingType === "групові");

  return (
    <PageLayout variant="top" action={<AdminMenu />}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-1">
        Панель тренера
      </h1>

      <p className="text-muted text-sm mb-1 capitalize">{longDay(schedule.localDate)}</p>

      {/* Push on this device when a client cancels or moves a booking (with the reason) */}
      <div className="mb-2">
        <PushSubscribeButton />
      </div>

      <div className="flex items-center space-x-2 mb-6">
        {schedule.status === "CANCELLED" ? (
          <Badge tone="danger">День скасовано</Badge>
        ) : !hasGroup ? null : schedule.bookingWindowOpen ? (
          <span className="text-sm font-semibold uppercase tracking-wide text-teal bg-teal/10 border border-teal/30 rounded-full px-4 py-1.5 flex items-center space-x-1.5">
            <span className="relative flex w-3 h-3 shrink-0 items-center justify-center mr-1.5">
              <span className="animate-ping absolute inline-flex h-3 w-3 rounded-full bg-teal opacity-75"></span>
              <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-teal"></span>
            </span>
            Запис відкрито
          </span>
        ) : afterWindow ? (
          <Badge>Запис закрито</Badge>
        ) : (
          <Badge>До {kyivTime(schedule.bookingOpenAt)}</Badge>
        )}
      </div>

      <div className="flex flex-col space-y-4 mb-6">
        {schedule.slots.map((slot) => (
          <AdminSlotCard key={slot.id} slot={slot} onMutate={handleMutate} />
        ))}
      </div>

      {mutateError && <p className="text-danger text-sm mb-4 text-center">{mutateError}</p>}

      {schedule.status !== "CANCELLED" && (
        <CancelDayButton
          date={schedule.localDate}
          onCancel={() => handleMutate(() => api.cancelTrainingDay(schedule.localDate))}
        />
      )}

      <AnnouncementSection
        date={schedule.localDate}
        announcement={announcement}
        examples={examples}
        onMutate={handleMutate}
      />
    </PageLayout>
  );
}
