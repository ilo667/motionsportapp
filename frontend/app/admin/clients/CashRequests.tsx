"use client";
import { useState } from "react";
import { api, CashRequest } from "@/lib/api";
import { formatUah, lineName } from "@/lib/prices";

// Top of «Клієнти»: clients who want to pay cash. «Оплату отримано» activates the purchase, «Відхилити» drops it
export function CashRequests({ requests, onDecided }: { requests: CashRequest[]; onDecided: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  if (requests.length === 0) return null;

  const decide = async (id: string, confirm: boolean) => {
    setBusyId(id);
    setError("");
    try {
      await (confirm ? api.confirmCash(id) : api.rejectCash(id));
    } catch {
      setError("Не вдалося зберегти. Оновіть сторінку й спробуйте ще раз.");
    } finally {
      setBusyId(null);
      onDecided();
    }
  };

  return (
    <section>
      <h2 className="font-geologica font-semibold text-heading uppercase mb-3">Підтвердьте оплату</h2>
      <div className="flex flex-col space-y-3">
        {requests.map((r) => (
          <div key={r.id} className="rounded-xl border border-line bg-surface p-4">
            <div className="text-heading font-semibold">{r.displayName}</div>
            {r.lines.map((l) => (
              <div key={lineName(l)} className="text-subtle text-xs mt-1">
                {l.section === "club_card" ? `Клубна карта · ${lineName(l)}` : lineName(l)}
              </div>
            ))}
            <button
              type="button"
              onClick={() => decide(r.id, true)}
              disabled={busyId === r.id}
              className="btn-primary w-full py-3.5 rounded-lg font-semibold mt-4 transition-colors disabled:opacity-60"
            >
              Отримано {formatUah(r.totalUah)}
            </button>
            <button
              type="button"
              onClick={() => decide(r.id, false)}
              disabled={busyId === r.id}
              className="block mx-auto text-subtle text-xs underline hover:text-body py-2 mt-1 transition-colors disabled:opacity-60"
            >
              Відхилити
            </button>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-danger text-xs mt-2">
          {error}
        </p>
      )}
    </section>
  );
}
