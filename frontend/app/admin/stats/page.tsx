"use client";
import { useState } from "react";
import { api, Revenue, TrainerStats } from "@/lib/api";
import { PageLayout } from "@/components/ui/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { TYPE_COLORS } from "@/lib/trainingTypes";
import { formatUah } from "@/lib/prices";
import { useAdminData } from "@/lib/useAdminData";
import { kyivToday } from "@/lib/dates";

const sectionTitle = "font-geologica font-semibold text-heading uppercase mb-3";
const label = "text-subtle text-xs font-semibold uppercase tracking-wide mb-2";

// Each column with its dot: training types in their calendar colors, club cards in the secondary text color
const REVENUE_ROWS: [keyof Omit<Revenue, "total">, string, string][] = [
  ["clubCards", "Клубні карти", ""], // the bg-subtle class (theme colors aren't CSS variables here)
  ["personal", "Персональні", TYPE_COLORS["personal"].border],
  ["split", "Спліт", TYPE_COLORS["split"].border],
  ["group", "Групові", TYPE_COLORS["group"].border],
];

// Months on the chart, current one last
const CHART_MONTHS = 12;
const SHORT_MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];

type MonthRevenue = TrainerStats["revenue"]["months"][number];

const noRevenue = (month: string): MonthRevenue => ({ month, clubCards: 0, personal: 0, split: 0, group: 0, total: 0 });

// Every month from the first paid one (at least the last 12, for the chart) up to the current one (Kyiv),
// with zeros for months nobody paid
function monthsUpToNow(months: MonthRevenue[]) {
  const [y, m] = kyivToday().split("-").map(Number);
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const firstPaid = months.reduce((first, x) => (x.month < first ? x.month : first), key(new Date(y, m - 1, 1)));
  const result: MonthRevenue[] = [];
  for (let i = 0; ; i++) {
    const k = key(new Date(y, m - 1 - i, 1));
    if (i >= CHART_MONTHS && k < firstPaid) break;
    result.unshift(months.find((x) => x.month === k) ?? noRevenue(k));
  }
  return result;
}

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
      {REVENUE_ROWS.map(([key, title, color]) => (
        <div key={key} className={`flex justify-between space-x-3 ${small ? "text-xs" : ""}`}>
          <span className="text-subtle flex items-center">
            <span
              className={`w-2 h-2 rounded-full mr-2 shrink-0${color ? "" : " bg-subtle"}`}
              style={color ? { backgroundColor: color } : undefined}
            />
            {title}
          </span>
          <span className={`tabular-nums ${revenue[key] ? "text-body" : "text-muted"}`}>{formatUah(revenue[key])}</span>
        </div>
      ))}
    </div>
  );
}

const BarsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M5 20V12M12 20V5M19 20v-9" strokeLinecap="round" />
  </svg>
);

const segButton = (on: boolean) =>
  `px-3.5 py-1.5 rounded-full transition-colors ${on ? "bg-teal text-on-teal font-semibold" : "text-subtle hover:text-body"}`;

// «Прибуток»: one card by default («Весь час», or a month with ‹ ›); «Графік» shows a bar per month for the
// last 12 instead, a tap on a bar picks the month. The picked month carries over between the two
function RevenueBlock({ revenue }: { revenue: TrainerStats["revenue"] }) {
  const months = monthsUpToNow(revenue.months);
  const [chart, setChart] = useState(false);
  const [allTime, setAllTime] = useState(false);
  const [selected, setSelected] = useState(months.length - 1);
  const month = months[selected];
  const shown = chart ? months.slice(-CHART_MONTHS) : [];
  const offset = months.length - shown.length;
  const max = Math.max(1, ...shown.map((m) => m.total));

  return (
    <div className="flex flex-col space-y-3">
      <div className="flex items-center justify-between space-x-3">
        {chart ? (
          <span className="text-subtle">
            За весь час: <span className="text-heading tabular-nums">{formatUah(revenue.allTime.total)}</span>
          </span>
        ) : (
          <div
            className="inline-flex border border-line rounded-full p-[3px] bg-surface"
            role="group"
            aria-label="Період"
          >
            <button onClick={() => setAllTime(true)} aria-pressed={allTime} className={segButton(allTime)}>
              Весь час
            </button>
            <button onClick={() => setAllTime(false)} aria-pressed={!allTime} className={segButton(!allTime)}>
              Місяць
            </button>
          </div>
        )}
        <button
          onClick={() => {
            setChart(!chart);
            // The chart shows the last 12 months: an older pick goes to the current month
            if (!chart && selected < months.length - CHART_MONTHS) setSelected(months.length - 1);
            setAllTime(false);
          }}
          aria-pressed={chart}
          className={`btn-ghost border rounded-full px-3 py-1.5 flex items-center shrink-0 transition-colors ${chart ? "text-accent" : ""}`}
        >
          <BarsIcon />
          <span className="ml-1.5">Графік</span>
        </button>
      </div>

      {chart && (
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-end space-x-1.5 h-36 border-b border-line">
            {shown.map((m, i) => (
              <button
                key={m.month}
                onClick={() => setSelected(offset + i)}
                aria-label={`${monthName(m.month)}: ${formatUah(m.total)}`}
                aria-pressed={offset + i === selected}
                className={`flex-1 rounded-t-md transition-colors ${offset + i === selected ? "bg-teal" : "bg-line hover:bg-muted"}`}
                style={{ height: `${Math.max(3, (m.total / max) * 100)}%` }}
              />
            ))}
          </div>
          <div className="flex space-x-1.5 mt-1.5">
            {shown.map((m, i) => (
              <span
                key={m.month}
                className={`flex-1 text-center text-[10px] ${offset + i === selected ? "text-heading" : "text-muted"}`}
              >
                {SHORT_MONTHS[Number(m.month.slice(5)) - 1]}
              </span>
            ))}
          </div>
        </div>
      )}

      {!chart && !allTime && (
        <div className="flex items-center justify-between space-x-3">
          <button
            onClick={() => setSelected(selected - 1)}
            disabled={selected === 0}
            aria-label="Попередній місяць"
            className="w-9 h-9 rounded-full border border-line bg-surface text-heading disabled:opacity-35"
          >
            ‹
          </button>
          <span className="text-heading font-semibold">{monthName(month.month)}</span>
          <button
            onClick={() => setSelected(selected + 1)}
            disabled={selected === months.length - 1}
            aria-label="Наступний місяць"
            className="w-9 h-9 rounded-full border border-line bg-surface text-heading disabled:opacity-35"
          >
            ›
          </button>
        </div>
      )}

      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-baseline justify-between space-x-3 mb-3">
          <span className={chart ? "text-heading font-semibold" : "text-subtle"}>
            {chart ? monthName(month.month) : "Разом"}
          </span>
          <span className="font-geologica text-heading tabular-nums text-sm">
            {formatUah(allTime && !chart ? revenue.allTime.total : month.total)}
          </span>
        </div>
        <RevenueRows revenue={allTime && !chart ? revenue.allTime : month} />
      </div>
    </div>
  );
}

// The trainer's own numbers: revenue (paid purchases of their clients, by the month paid) and load (people ✓)
export default function StatsPage() {
  const { data: stats, error } = useAdminData(api.getStats);
  const loadError = error != null;

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

            <RevenueBlock revenue={stats.revenue} />
          </section>

          <section>
            <h2 className={sectionTitle}>Завантаженість</h2>
            <p className="text-subtle text-xs mb-3">
              Скільки людей прийшло (✓) на ваші тренування, гості теж. Сьогоднішній день зʼявиться завтра.
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
