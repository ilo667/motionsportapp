"use client";
import { useState } from "react";
import { api, CashRequest } from "@/lib/api";
import { formatUah, lineName } from "@/components/PurchaseFlow";

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
          <div key={r.id} className="rounded-xl border-2 border-line bg-surface p-4">
            <div className="text-heading font-medium mb-1">{r.displayName}</div>
            {r.lines.map((l) => (
              <div key={lineName(l)} className="flex justify-between space-x-3 text-sm py-0.5">
                <span className="text-body">{lineName(l)}</span>
                <span className="text-body tabular-nums">{formatUah(l.amountUah)}</span>
              </div>
            ))}
            <div className="flex justify-between space-x-3 border-t border-line pt-2 mt-2">
              <span className="text-muted text-sm">Разом</span>
              <span className="font-geologica text-heading tabular-nums">{formatUah(r.totalUah)}</span>
            </div>
            <div className="flex justify-end space-x-2 mt-3">
              <button
                onClick={() => decide(r.id, false)}
                disabled={busyId === r.id}
                className="btn-ghost px-4 py-2 rounded-lg border text-sm transition-colors disabled:opacity-60"
              >
                Відхилити
              </button>
              <button
                onClick={() => decide(r.id, true)}
                disabled={busyId === r.id}
                className="btn-primary px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
              >
                Оплату отримано
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <p className="text-danger text-sm mt-2">{error}</p>}
    </section>
  );
}
