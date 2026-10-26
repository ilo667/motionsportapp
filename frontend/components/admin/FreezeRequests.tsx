"use client";
import { useState } from "react";
import { api, FreezeRequest } from "@/lib/api";

const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

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
              <p className="text-body text-sm mt-3">
                Записи клієнта на тренування до {ddmm(r.until)} буде скасовано, строки клубної карти й тренувань
                подовжаться на 30 днів.
              </p>
            ) : null}
            <button
              onClick={() => (r.kind === "freeze" && confirmId !== r.id ? setConfirmId(r.id) : decide(r, true))}
              disabled={busyId === r.id}
              className="btn-primary w-full py-3.5 rounded-xl font-semibold mt-4 transition-colors disabled:opacity-60"
            >
              {r.kind === "unfreeze" ? "Розморозити з сьогодні" : confirmId === r.id ? "Так, заморозити" : "Заморозити"}
            </button>
            <button
              onClick={() => (confirmId === r.id ? setConfirmId(null) : decide(r, false))}
              disabled={busyId === r.id}
              className="block mx-auto text-subtle text-xs underline hover:text-body py-2 mt-1 transition-colors disabled:opacity-60"
            >
              {confirmId === r.id ? "Назад" : "Відхилити"}
            </button>
          </div>
        ))}
      </div>
      {error && <p className="text-danger text-xs mt-2">{error}</p>}
    </section>
  );
}
