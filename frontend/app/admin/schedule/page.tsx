"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, TrainerSchedule } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";

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

const ERROR_TEXTS: [string, string][] = [
  ["Booking must open before the first training", "Запис має відкриватися раніше за перше тренування"],
  ["Group trainings are from 06:00 to 21:00", "Групові можна ставити з 06:00 до 21:00"],
  ["at least an hour apart", "Між груповими має бути щонайменше година"],
  ["15-minute steps", "Час — кроком 15 хвилин"],
];

// One line after «Зберегти»: what went into the calendar
// No counts: the trainings could not be added right now (they appear on the next schedule load)
function savedText(autoCreate: boolean, added?: number, skipped?: number) {
  if (!autoCreate || added === undefined || skipped === undefined) return "Збережено";
  if (added === 0 && skipped === 0) return "Збережено. Усі тренування вже в календарі";
  const left = skipped
    ? `. ${skipped} ${plural(skipped, ["тренування", "тренування", "тренувань"])} пропущено — там уже є тренування або групові скасовані, перевірте календар`
    : "";
  return `Збережено. Додано в календар: ${added} ${plural(added, ["тренування", "тренування", "тренувань"])}${left}`;
}

// Ukrainian forms for 1, 2–4 and 5+ («1 тренування», «3 дати», «21 дату»)
function plural(n: number, [one, few, many]: [string, string, string]) {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
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
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMySchedule()
      .then(setSchedule)
      .catch((err: unknown) => {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) router.push("/admin/login");
        else setLoadError(true);
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
    if (!TIME_RE.test(draft)) return setError("Час — кроком 15 хвилин, наприклад 18:30");
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
      const raw = err instanceof Error ? err.message : "";
      setError(ERROR_TEXTS.find(([needle]) => raw.includes(needle))?.[1] ?? "Не вдалося зберегти. Спробуйте ще раз.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageLayout variant="top" loading={!schedule && !loadError} action={<AdminMenu />}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">
        Розклад групових
      </h1>

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

          <div className="flex items-center justify-between space-x-4">
            <label htmlFor="opens-at" className="text-heading text-sm">
              Запис відкривається о
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
          {saved && <p className="text-accent text-sm">{saved}</p>}

          <button
            onClick={save}
            disabled={saving}
            className="btn-primary w-full py-3.5 rounded-xl font-semibold transition-colors disabled:opacity-60"
          >
            {saving ? "Збереження..." : "Зберегти"}
          </button>
        </div>
      )}
    </PageLayout>
  );
}
