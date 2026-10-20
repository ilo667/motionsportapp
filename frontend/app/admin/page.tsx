"use client";
import { useEffect, useRef, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { api, AdminSchedule, Announcement, AnnouncementExample } from "@/lib/api";
import { SlotCard as AdminSlotCard } from "@/components/admin/SlotCard";
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

export default function AdminPage() {
  const router = useRouter();
  const [schedule, setSchedule] = useState<AdminSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutateError, setMutateError] = useState("");
  const [confirmCancelDay, setConfirmCancelDay] = useState(false);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [examples, setExamples] = useState<AnnouncementExample[]>([]);
  const [newExampleText, setNewExampleText] = useState("");
  const [editingText, setEditingText] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const authedRef = useRef(false);

  const fetchSchedule = useCallback(async () => {
    try {
      const data = await api.getAdminSchedule();
      setSchedule(data);
      const [ann, exs] = await Promise.all([
        api.getAnnouncement(data.localDate).catch(() => null),
        api.listAnnouncementExamples().catch(() => []),
      ]);
      setAnnouncement(ann);
      setExamples(exs);
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
    return <GymLoader />;
  }

  if (!schedule) {
    return <p className="text-danger text-sm">Не вдалося завантажити розклад.</p>;
  }

  const now = new Date(schedule.serverTime);
  const closeAt = new Date(schedule.bookingCloseAt);
  const afterWindow = now >= closeAt;

  return (
    <>
      <div className="flex items-start justify-between mb-1">
          <h1 className="font-geologica font-semibold text-title sm:text-display text-heading">
            Панель тренера
          </h1>
          <button
            onClick={handleLogout}
            className="text-body text-sm hover:text-heading transition-colors mt-1 ml-4 shrink-0"
          >
            Вийти
          </button>
        </div>

        <p className="text-body text-sm mb-1 capitalize">
          {formatLocalDate(schedule.localDate)}
        </p>

        <div className="flex items-center space-x-2 mb-6">
          {schedule.status === "CANCELLED" ? (
            <span className="text-xs text-danger bg-danger/10 border border-danger/30 rounded-full px-2 py-0.5">
              День скасовано
            </span>
          ) : schedule.bookingWindowOpen ? (
            <span className="text-xs font-semibold uppercase tracking-wide text-teal bg-teal/10 border border-teal/30 rounded-full px-3 py-1 flex items-center gap-1.5">
              <span className="relative flex w-1.5 h-1.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal opacity-60"></span>
                <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-teal"></span>
              </span>
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

        <div className="flex flex-col space-y-4 mb-6">
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
                className="btn-ghost hover-danger w-full py-3 rounded-lg border text-sm transition-colors"
              >
                Скасувати весь день
              </button>
            ) : (
              <div className="rounded-lg border border-danger bg-danger/5 p-4 space-y-3">
                <p className="text-danger text-sm">
                  Скасувати тренування {formatLocalDate(schedule.localDate)}? Всі записи буде відмінено.
                </p>
                <div className="flex space-x-2">
                  <button
                    onClick={handleCancelDay}
                    className="btn-danger flex-1 py-2.5 rounded-md text-sm font-medium transition-colors"
                  >
                    Скасувати день
                  </button>
                  <button
                    onClick={() => setConfirmCancelDay(false)}
                    className="btn-ghost flex-1 py-2.5 rounded-md border text-sm transition-colors"
                  >
                    Ні
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Announcement section */}
        <div className="border-t border-line pt-5 mt-5">
          <p className="text-muted text-xs mb-3 uppercase tracking-wide font-medium">
            Оголошення
          </p>

          {/* Published status */}
          {announcement?.publishedAt ? (
            <div className="bg-teal/8 border border-teal/20 rounded-xl px-4 py-3 mb-4 text-sm text-body">
              <p className="font-medium text-teal mb-1 text-xs">✓ Опубліковано</p>
              {announcement.text}
            </div>
          ) : announcement?.text ? (
            <div className="bg-surface border border-line rounded-xl px-4 py-3 mb-4 text-sm text-muted">
              <p className="font-medium text-xs mb-1">Чернетка (не опубліковано)</p>
              {announcement.text}
            </div>
          ) : null}

          {/* Edit area */}
          {editingText !== null ? (
            <div className="mb-3 space-y-2">
              <textarea
                value={editingText}
                onChange={(e) => setEditingText(e.target.value)}
                rows={3}
                className="input-field w-full rounded-lg border px-3 py-2 text-sm resize-none focus:outline-none focus:border-teal"
                placeholder="Текст оголошення..."
              />
              <div className="flex space-x-2">
                <button
                  onClick={async () => {
                    await handleMutate(() => api.updateAnnouncementText(schedule.localDate, editingText));
                    setEditingText(null);
                  }}
                  className="btn-primary flex-1 py-2 rounded-md text-sm transition-colors"
                >
                  Зберегти
                </button>
                <button
                  onClick={() => setEditingText(null)}
                  className="btn-ghost flex-1 py-2 rounded-md border text-sm transition-colors"
                >
                  Скасувати
                </button>
              </div>
            </div>
          ) : null}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 mb-4">
            <button
              disabled={generating}
              onClick={async () => {
                setGenerating(true);
                await handleMutate(() => api.generateAnnouncement(schedule.localDate));
                setGenerating(false);
              }}
              className="btn-secondary py-2 px-3 rounded-lg border text-sm transition-colors disabled:opacity-50"
            >
              {generating ? "Генерую..." : "✨ Згенерувати AI"}
            </button>
            {announcement?.text && !announcement.publishedAt && (
              <>
                <button
                  onClick={() => setEditingText(announcement.text ?? "")}
                  className="btn-ghost py-2 px-3 rounded-lg border text-sm transition-colors"
                >
                  Редагувати
                </button>
                <button
                  onClick={() => handleMutate(() => api.publishAnnouncement(schedule.localDate))}
                  className="btn-primary py-2 px-3 rounded-lg text-sm transition-colors"
                >
                  Опублікувати
                </button>
              </>
            )}
            {announcement?.publishedAt && (
              <button
                onClick={() => handleMutate(() => api.unpublishAnnouncement(schedule.localDate))}
                className="btn-ghost hover-danger py-2 px-3 rounded-lg border text-sm transition-colors"
              >
                Зняти з публікації
              </button>
            )}
          </div>

          {/* Examples */}
          <p className="text-muted text-xs mb-2 font-medium">Приклади стилю для AI</p>
          <div className="space-y-2 mb-3">
            {examples.map((ex) => (
              <div key={ex.id} className="flex items-start space-x-2 bg-surface rounded-lg px-3 py-2">
                <p className="flex-1 text-sm text-body">{ex.text}</p>
                <button
                  onClick={() => handleMutate(() => api.deleteAnnouncementExample(ex.id))}
                  className="text-muted hover:text-danger text-xs shrink-0 mt-0.5 transition-colors"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="flex space-x-2">
            <input
              type="text"
              value={newExampleText}
              onChange={(e) => setNewExampleText(e.target.value)}
              placeholder="Додати приклад оголошення..."
              className="input-field flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:border-teal"
              onKeyDown={async (e) => {
                if (e.key === "Enter" && newExampleText.trim()) {
                  await handleMutate(() => api.addAnnouncementExample(newExampleText.trim()));
                  setNewExampleText("");
                }
              }}
            />
            <button
              onClick={async () => {
                if (!newExampleText.trim()) return;
                await handleMutate(() => api.addAnnouncementExample(newExampleText.trim()));
                setNewExampleText("");
              }}
              className="btn-primary py-2 px-3 rounded-lg text-sm transition-colors"
            >
              +
            </button>
          </div>
        </div>
      {schedule.isDemoMode && <DemoControls onRefresh={fetchSchedule} />}
    </>
  );
}