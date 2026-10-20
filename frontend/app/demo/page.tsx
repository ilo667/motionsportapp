"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import Link from "next/link";

const SCENARIOS = [
  {
    key: "before_14",
    label: "До 14:00",
    desc: "Запис ще не відкрито — кнопки неактивні",
  },
  {
    key: "booking_open",
    label: "Запис відкрито",
    desc: "7/8 + 3/8 — є вільні місця на обох слотах",
  },
  {
    key: "one_full",
    label: "Один слот повний",
    desc: "8/8 + 3/8 — перший слот заповнений",
  },
  {
    key: "after_21",
    label: "Після 21:00",
    desc: "Запис закрито — тренування вже сьогодні",
  },
] as const;

export default function DemoPage() {
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

  async function apply(scenario: string) {
    setBusy(true);
    try {
      await api.setDemoScenario(scenario);
      setApplied(scenario);
    } catch {
      // ignore — demo may not be enabled in current env
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#0f2027] text-white px-4 py-10">
      <div className="max-w-lg mx-auto">
        <p className="text-xs font-mono uppercase tracking-widest text-white/40 mb-1">Demo</p>
        <h1 className="font-geologica text-3xl font-bold mb-2">Motion Gym</h1>
        <p className="text-white/60 mb-10 text-sm">
          Демо-середовище для перегляду всіх сценаріїв запису на тренування.
        </p>

        {/* Credentials */}
        <section className="mb-8">
          <h2 className="text-xs font-mono uppercase tracking-widest text-white/40 mb-3">Облікові дані</h2>
          <div className="grid gap-3">
            <CredCard
              label="Учасник"
              rows={[
                { name: "Код учасника", value: "GYM-DEMO" },
                { name: "PIN-код", value: "123456" },
              ]}
              href="/login"
              cta="Увійти як учасник"
            />
            <CredCard
              label="Адмін"
              rows={[
                { name: "Логін", value: "demo" },
                { name: "Пароль", value: "Demo1234!" },
              ]}
              href="/admin"
              cta="Увійти як адмін"
            />
          </div>
        </section>

        {/* Scenarios */}
        <section className="mb-8">
          <h2 className="text-xs font-mono uppercase tracking-widest text-white/40 mb-3">Сценарії</h2>
          <div className="grid gap-2">
            {SCENARIOS.map((s) => (
              <button
                key={s.key}
                onClick={() => apply(s.key)}
                disabled={busy}
                className={`text-left rounded-[10px] border px-4 py-3 transition-colors ${
                  applied === s.key
                    ? "border-teal bg-teal/10"
                    : "border-white/10 bg-white/5 hover:bg-white/10"
                } disabled:opacity-50`}
              >
                <p className="font-medium text-sm">{s.label}</p>
                <p className="text-xs text-white/50 mt-0.5">{s.desc}</p>
              </button>
            ))}
          </div>
          {applied && (
            <p className="mt-3 text-xs text-teal">
              Сценарій «{SCENARIOS.find((s) => s.key === applied)?.label}» застосовано.{" "}
              <Link href="/" className="underline">
                Перейти до розкладу →
              </Link>
            </p>
          )}
        </section>

        <p className="text-xs text-white/30 text-center">
          Demo-режим. Дані не збережуться після скидання.
        </p>
      </div>
    </main>
  );
}

function CredCard({
  label,
  rows,
  href,
  cta,
}: {
  label: string;
  rows: { name: string; value: string }[];
  href: string;
  cta: string;
}) {
  return (
    <div className="rounded-[10px] border border-white/10 bg-white/5 px-4 py-3">
      <p className="text-xs text-white/40 mb-2">{label}</p>
      <div className="grid gap-1 mb-3">
        {rows.map((r) => (
          <div key={r.name} className="flex justify-between items-center">
            <span className="text-sm text-white/60">{r.name}</span>
            <code className="text-sm font-mono bg-white/10 px-2 py-0.5 rounded">{r.value}</code>
          </div>
        ))}
      </div>
      <Link
        href={href}
        className="inline-block text-sm text-teal hover:underline"
      >
        {cta} →
      </Link>
    </div>
  );
}