"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, Revenue, TrainerStats } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { formatUah } from "@/components/PurchaseFlow";

const sectionTitle = "font-geologica font-semibold text-heading uppercase mb-3";
const label = "text-subtle text-xs font-semibold uppercase tracking-wide mb-2";

const REVENUE_ROWS: [keyof Omit<Revenue, "total">, string][] = [
  ["clubCards", "Клубні карти"],
  ["personal", "Персональні"],
  ["split", "Спліт"],
  ["group", "Групові"],
];

const WEEKDAYS = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

// «жовтень 2026»
function monthName(month: string) {
  const name = new Date(`${month}-01T12:00:00`).toLocaleDateString("uk-UA", { month: "long" });
  return `${name[0].toUpperCase()}${name.slice(1)} ${month.slice(0, 4)}`;
}

// «ср, 21 жовтня»
function dayName(localDate: string) {
  return new Date(`${localDate}T12:00:00`).toLocaleDateString("uk-UA", {
    weekday: "short",
    day: "numeric",
    month: "long",
  });
}

// 1 людина, 3 людини, 5 людей
function people(n: number) {
  const tens = n % 100;
  const ones = n % 10;
  const word = tens >= 11 && tens <= 14 ? "людей" : ones === 1 ? "людина" : ones >= 2 && ones <= 4 ? "людини" : "людей";
  return `${n} ${word}`;
}

function RevenueRows({ revenue, small }: { revenue: Revenue; small?: boolean }) {
  return (
    <div className="flex flex-col space-y-1.5">
      {REVENUE_ROWS.map(([key, title]) => (
        <div key={key} className={`flex justify-between space-x-3 ${small ? "text-xs" : ""}`}>
          <span className="text-subtle">{title}</span>
          <span className={`tabular-nums ${revenue[key] ? "text-body" : "text-muted"}`}>{formatUah(revenue[key])}</span>
        </div>
      ))}
    </div>
  );
}

// The trainer's own numbers: revenue (paid purchases of their clients, by the month paid) and load (people ✓)
export default function StatsPage() {
  const router = useRouter();
  const [stats, setStats] = useState<TrainerStats | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    api
      .getStats()
      .then(setStats)
      .catch((err: unknown) => {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) router.push("/admin/login");
        else setLoadError(true);
      });
  }, [router]);

  const maxAvg = Math.max(1, ...(stats?.weekdays.map((w) => w.avgPresent) ?? []));

  return (
    <PageLayout variant="top" loading={!stats && !loadError} action={<AdminMenu />}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">
        Статистика
      </h1>

      {loadError && <p className="text-danger text-sm">Не вдалося завантажити статистику.</p>}

      {stats && (
        <div className="flex flex-col space-y-8">
          <section>
            <h2 className={sectionTitle}>Прибуток</h2>
            <p className="text-subtle text-xs mb-3">Оплачені покупки ваших клієнтів, за датою оплати.</p>

            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-baseline justify-between space-x-3 mb-3">
                <span className="text-heading font-semibold">За весь час</span>
                <span className="font-geologica text-heading tabular-nums">
                  {formatUah(stats.revenue.allTime.total)}
                </span>
              </div>
              <RevenueRows revenue={stats.revenue.allTime} />
            </div>

            {stats.revenue.months.length > 0 && (
              <div className="flex flex-col space-y-3 mt-3">
                {stats.revenue.months.map((m) => (
                  <div key={m.month} className="rounded-xl border border-line bg-surface p-4">
                    <div className="flex items-baseline justify-between space-x-3 mb-2">
                      <span className="text-heading font-semibold">{monthName(m.month)}</span>
                      <span className="text-heading tabular-nums">{formatUah(m.total)}</span>
                    </div>
                    <RevenueRows revenue={m} small />
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className={sectionTitle}>Завантаженість</h2>
            <p className="text-subtle text-xs mb-3">
              Скільки людей прийшло (✓) на ваші тренування, гості теж. Сьогоднішні дні — з завтрашнього дня.
            </p>

            {stats.busiestDays.length === 0 ? (
              <p className="text-muted text-sm">Ще немає минулих тренувань з відмітками.</p>
            ) : (
              <div className="flex flex-col space-y-6">
                <div>
                  <h3 className={label}>Найбільше людей</h3>
                  <div className="flex flex-col">
                    {stats.busiestDays.map((d) => (
                      <div
                        key={d.localDate}
                        className="flex justify-between space-x-3 py-1.5 border-b border-line last:border-0"
                      >
                        <span className="text-heading">{dayName(d.localDate)}</span>
                        <span className="text-body tabular-nums">{people(d.present)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h3 className={label}>У середньому за день тижня</h3>
                  <div className="flex flex-col space-y-2">
                    {stats.weekdays.map((w) => (
                      <div key={w.weekday} className="flex items-center space-x-3">
                        <span className="text-subtle w-6 shrink-0">{WEEKDAYS[w.weekday]}</span>
                        <div className="flex-1 h-2 rounded-full bg-line overflow-hidden">
                          <div
                            className="h-full rounded-full bg-teal"
                            style={{ width: `${(w.avgPresent / maxAvg) * 100}%` }}
                          />
                        </div>
                        <span className="text-body tabular-nums w-10 text-right shrink-0">
                          {w.avgPresent.toLocaleString("uk-UA")}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-muted text-xs mt-2">Середнє за всі дні, коли у вас були тренування.</p>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </PageLayout>
  );
}
