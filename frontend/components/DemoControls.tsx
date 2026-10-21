"use client";

import { useState } from "react";
import { api } from "@/lib/api";

const SCENARIOS = [
  { key: "before_14", label: "До 14:00" },
  { key: "booking_open", label: "Запис відкрито" },
  { key: "one_full", label: "Один слот повний" },
  { key: "after_21", label: "Після 21:00" },
  { key: "payment_test", label: "Тест оплати" },
] as const;

interface DemoControlsProps {
  onRefresh: () => void;
}

export default function DemoControls({ onRefresh }: DemoControlsProps) {
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  async function applyScenario(scenario: string) {
    setBusy(true);
    try {
      await api.setDemoScenario(scenario);
      setActive(scenario);
      onRefresh();
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      await api.resetDemo();
      setActive(null);
      onRefresh();
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-[#0d1019]/95 border-t border-[#1a2040] px-3 py-2">
      <div className="max-w-lg mx-auto">
        <p className="text-[10px] text-white/40 mb-1.5 font-mono uppercase tracking-widest">Demo controls</p>
        <div className="-m-0.5 flex flex-wrap">
          {SCENARIOS.map((s) => (
            <button
              key={s.key}
              onClick={() => applyScenario(s.key)}
              disabled={busy}
              className={`m-0.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
                active === s.key
                  ? "btn-primary"
                  : "bg-white/10 text-white hover:bg-white/20"
              } disabled:opacity-50`}
            >
              {s.label}
            </button>
          ))}
          <button
            onClick={reset}
            disabled={busy}
            className="m-0.5 ml-auto px-2 py-1 rounded text-xs font-medium bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors disabled:opacity-50"
          >
            Скинути
          </button>
        </div>
      </div>
    </div>
  );
}