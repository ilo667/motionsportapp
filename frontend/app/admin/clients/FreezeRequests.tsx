"use client";
import { useState } from "react";
import { api, FreezeRequest } from "@/lib/api";
import { ddmm } from "@/lib/dates";

// Top of «Клієнти»: clients asking to freeze (from today, 30 days) or to unfreeze (from today). Freezing cancels
// their trainings in those days, so «Підтвердити» asks once more
export function FreezeRequests({ requests, onDecided }: { requests: FreezeRequest[]; onDecided: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState("");

  if (requests.length === 0) return null;

  const decide = async (r: FreezeRequest, approve: boolean) => {
    setBusyId(r.id);
    setError("");
    try {
      await api.decideFreeze(r, approve);
    } catch {
      setError("Не вдалося зберегти. Оновіть сторінку й спробуйте ще раз.");
    } finally {
      setBusyId(null);
      setConfirmId(null);
      onDecided();
    }
  };

  return (
    <section>
      <h2 className="font-geologica font-semibold text-heading uppercase mb-3">Заморозка</h2>
      <div className="flex flex-col space-y-3">
        {requests.map((r) => (
          <div key={r.id} className="rounded-xl border border-line bg-surface p-4">
            <div className="text-heading font-semibold">{r.displayName}</div>
            <div className="text-subtle text-xs mt-1">
              {r.kind === "freeze"
                ? `Просить заморозити: з сьогодні до ${ddmm(r.until)} включно`
                : `Просить розморозити (заморожено до ${ddmm(r.until)})`}
            </div>
            {confirmId === r.id ? (
              // Same confirmation as «Скасувати мої тренування цього дня»: the action and «Ні» side by side
              <div className="rounded-lg border border-line bg-background p-4 space-y-3 mt-4">
                <p className="text-body text-sm">
                  Заморозка до {ddmm(r.until)}. Записи на ці дні скасуються, а клубна карта й тренування не згорять:
                  строки подовжаться на час заморозки.
                </p>
                <div className="flex space-x-2">
                  <button
                    type="button"
                    onClick={() => decide(r, true)}
                    disabled={busyId === r.id}
                    className="btn-primary flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
                  >
                    Заморозити
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    disabled={busyId === r.id}
                    className="btn-ghost flex-1 py-2.5 rounded-lg border text-sm transition-colors disabled:opacity-60"
                  >
                    Ні
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => (r.kind === "freeze" ? setConfirmId(r.id) : decide(r, true))}
                  disabled={busyId === r.id}
                  className="btn-primary w-full py-3.5 rounded-lg font-semibold mt-4 transition-colors disabled:opacity-60"
                >
                  {r.kind === "unfreeze" ? "Розморозити з сьогодні" : "Заморозити"}
                </button>
                <button
                  type="button"
                  onClick={() => decide(r, false)}
                  disabled={busyId === r.id}
                  className="block mx-auto text-subtle text-xs underline hover:text-body py-2 mt-1 transition-colors disabled:opacity-60"
                >
                  Відхилити
                </button>
              </>
            )}
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
