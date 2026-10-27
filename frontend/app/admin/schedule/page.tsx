"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, SkippedTraining, TrainerSchedule } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { errorText } from "@/lib/apiErrors";
import { trainingsCount } from "@/lib/plural";
import { toAdminLogin } from "@/lib/adminAuth";

// Weekdays as the backend counts them (1 = Пн … 7 = Нд)
const WEEKDAYS = [
  { n: 1, short: "Пн" },
  { n: 2, short: "Вт" },
  { n: 3, short: "Ср" },
  { n: 4, short: "Чт" },
  { n: 5, short: "Пт" },
  { n: 6, short: "Сб" },
  { n: 7, short: "Нд" },
];

const TIME_RE = /^([01]\d|2[0-3]):(00|15|30|45)$/;
const TIME_FIELD =
  "input-field border rounded-lg px-3 py-2 text-sm focus:outline-none block min-w-0 appearance-none [color-scheme:dark] [&::-webkit-date-and-time-value]:text-left";

const SKIP_REASONS: Record<SkippedTraining["reason"], string> = {
  cancelled: "скасовано в календарі",
  taken: "час зайнятий іншим тренуванням",
};

// After «Зберегти»: what went into the calendar, and the trainings left out, one line per date and reason
// («вт 27.10 о 15:00 і 17:00 (скасовано в календарі)»). No counts: the trainings could not be added right now
// (they appear on the next schedule load)
function savedText(autoCreate: boolean, added?: number, skipped?: SkippedTraining[]) {
  if (!autoCreate || added === undefined || skipped === undefined) return { text: "Збережено", skipped: [] };
  if (added === 0 && skipped.length === 0) return { text: "Збережено. Усі тренування вже в календарі", skipped: [] };
  const lines: { key: string; date: string; times: string[]; reason: string }[] = [];
  for (const s of skipped) {
    const key = `${s.date}|${s.reason}`;
    const line = lines.find((l) => l.key === key);
    if (line) line.times.push(s.slotTime);
    else lines.push({ key, date: s.date, times: [s.slotTime], reason: SKIP_REASONS[s.reason] });
  }
  return {
    text: `Збережено. У календар додано ${trainingsCount(added)}`,
    skipped: lines.map((l) => `${shortDate(l.date)} о ${listTimes(l.times)} (${l.reason})`),
  };
}

// «15:00», «15:00 і 17:00», «10:00, 15:00 і 17:00»
function listTimes(times: string[]) {
  return times.length > 1 ? `${times.slice(0, -1).join(", ")} і ${times[times.length - 1]}` : times[0];
}

// «вт 27.10»
function shortDate(date: string) {
  const d = new Date(date + "T12:00:00");
  const weekday = d.toLocaleDateString("uk-UA", { weekday: "short" });
  return `${weekday} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// «Розклад групових»: the trainer's regular group trainings, created 3 weeks ahead by themselves
export default function GroupSchedulePage() {
  const router = useRouter();
  const [schedule, setSchedule] = useState<TrainerSchedule | null>(null);
  const [loadError, setLoadError] = useState(false);
  // The weekday whose «+ час» field is open, and what is typed there
  const [adding, setAdding] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // What the last save put in the calendar; null until saved (or after an edit)
  const [saved, setSaved] = useState<{ text: string; skipped: string[] } | null>(null);

  useEffect(() => {
    api
      .getMySchedule()
      .then(setSchedule)
      .catch((err: unknown) => {
        if (!toAdminLogin(err, router)) setLoadError(true);
      });
  }, [router]);

  const change = (next: TrainerSchedule) => {
    setSchedule(next);
    setSaved(null);
    setError("");
  };

  const timesOf = (weekday: number) =>
    (schedule?.times ?? [])
      .filter((t) => t.weekday === weekday)
      .map((t) => t.slotTime)
      .sort();

  const addTime = (weekday: number) => {
    if (!schedule) return;
    if (!TIME_RE.test(draft)) return setError("Час кроком 15 хвилин, наприклад 18:30");
    if (!timesOf(weekday).includes(draft)) {
      change({ ...schedule, times: [...schedule.times, { weekday, slotTime: draft }] });
    }
    setAdding(null);
    setDraft("");
  };

  const removeTime = (weekday: number, slotTime: string) => {
    if (!schedule) return;
    change({
      ...schedule,
      times: schedule.times.filter((t) => !(t.weekday === weekday && t.slotTime === slotTime)),
    });
  };

  const save = async () => {
    if (!schedule) return;
    if (!TIME_RE.test(schedule.bookingOpensAt))
      return setError("Вкажіть, о котрій відкривається запис, наприклад 14:00");
    setSaving(true);
    setError("");
    try {
      const { added, skipped, ...next } = await api.saveMySchedule(schedule);
      setSchedule(next);
      setSaved(savedText(next.autoCreate, added, skipped));
    } catch (err) {
      setError(errorText(err, "Не вдалося зберегти. Спробуйте ще раз."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageLayout variant="top" loading={!schedule && !loadError} action={<AdminMenu />}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-2">
        Розклад групових
      </h1>
      <p className="text-muted text-sm mb-6">
        Шаблон на кожен тиждень: за ним тренування самі з&apos;являються в календарі на 3 тижні вперед. Разове
        тренування додавайте в календарі.
      </p>

      {loadError && <p className="text-danger text-sm">Не вдалося завантажити розклад.</p>}

      {schedule && (
        <div className="flex flex-col space-y-6">
          <div className="border-t border-line">
            {WEEKDAYS.map(({ n, short }) => {
              const times = timesOf(n);
              return (
                <div key={n} className="flex items-center space-x-3 py-3 border-b border-line">
                  <span className={`w-7 shrink-0 font-semibold ${times.length ? "text-heading" : "text-subtle"}`}>
                    {short}
                  </span>
                  <div className="flex flex-wrap items-center flex-1 -m-1 min-w-0">
                    {times.length === 0 && adding !== n && <span className="m-1 text-subtle text-sm">вихідний</span>}
                    {times.map((t) => (
                      <button
                        key={t}
                        onClick={() => removeTime(n, t)}
                        aria-label={`Прибрати ${short} ${t}`}
                        className="m-1 text-sm text-heading bg-surface border border-line rounded-full px-3 py-1 hover:border-danger transition-colors"
                      >
                        {t} <span className="text-subtle ml-1">✕</span>
                      </button>
                    ))}
                    {adding === n && (
                      <span className="m-1 flex items-center space-x-2">
                        <input
                          autoFocus
                          type="time"
                          step={900}
                          aria-label={`Новий час, ${short}`}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") addTime(n);
                            if (e.key === "Escape") setAdding(null);
                          }}
                          className={`${TIME_FIELD} w-36`}
                        />
                        <button
                          onClick={() => addTime(n)}
                          className="btn-primary px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                        >
                          Додати
                        </button>
                      </span>
                    )}
                  </div>
                  {adding !== n && (
                    <button
                      onClick={() => {
                        setAdding(n);
                        setDraft("");
                      }}
                      className="shrink-0 text-accent text-sm border border-dashed border-line rounded-full px-3 py-1 hover:border-accent transition-colors"
                    >
                      + час
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between space-x-4 rounded-xl border border-line p-4">
            <label htmlFor="opens-at" className="text-heading text-sm">
              Запис відкривається о
              <span className="block text-muted text-xs mt-1">
                для всіх ваших групових, зокрема доданих у календарі
              </span>
            </label>
            <input
              id="opens-at"
              type="time"
              step={900}
              value={schedule.bookingOpensAt}
              onChange={(e) => change({ ...schedule, bookingOpensAt: e.target.value })}
              className={`${TIME_FIELD} w-36`}
            />
          </div>

          <div className="flex items-center justify-between space-x-4">
            <span id="auto-create" className="text-heading text-sm">
              Автоматично додавати на 3 тижні наперед
            </span>
            <button
              role="switch"
              aria-checked={schedule.autoCreate}
              aria-labelledby="auto-create"
              onClick={() => change({ ...schedule, autoCreate: !schedule.autoCreate })}
              className={`relative w-12 h-7 shrink-0 rounded-full transition-colors ${schedule.autoCreate ? "bg-accent" : "bg-line"}`}
            >
              <span
                className={`absolute top-1 w-5 h-5 rounded-full transition-all ${schedule.autoCreate ? "right-1 bg-background" : "left-1 bg-subtle"}`}
              />
            </button>
          </div>

          {error && <p className="text-danger text-sm">{error}</p>}
          {saved && (
            <div className="space-y-2">
              <p className="text-accent text-sm">{saved.text}</p>
              {saved.skipped.length > 0 && (
                <div className="text-sm">
                  <p className="text-heading">Не додано:</p>
                  <ul className="text-muted space-y-1 mt-1">
                    {saved.skipped.map((line) => (
                      <li key={line}>• {line}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <button
            onClick={save}
            disabled={saving}
            className="btn-primary w-full py-3.5 rounded-lg font-semibold transition-colors disabled:opacity-60"
          >
            {saving ? "Збереження..." : "Зберегти"}
          </button>
        </div>
      )}
    </PageLayout>
  );
}
