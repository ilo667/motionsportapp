"use client";
import { useState } from "react";
import { api, CancelRefund } from "@/lib/api";
import { ddmm } from "@/lib/dates";
import { TYPE_LABEL } from "@/lib/trainingTypes";
import { formatUah } from "@/lib/prices";

// Half refunds after a late cancellation (2-24 h before); the app sends no money, the trainer only marks it done
export function CancelRefunds({ refunds, onDone }: { refunds: CancelRefund[]; onDone: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  if (refunds.length === 0) return null;

  const done = async (id: string) => {
    setBusyId(id);
    setError("");
    try {
      await api.markCancelRefundDone(id);
    } catch {
      setError("Не вдалося зберегти. Оновіть сторінку й спробуйте ще раз.");
    } finally {
      setBusyId(null);
      onDone();
    }
  };

  return (
    <section>
      <h2 className="font-geologica font-semibold text-heading uppercase mb-1">Повернути гроші</h2>
      <p className="text-muted text-xs mb-3">
        Клієнт скасував разове тренування менш ніж за добу: поверніть половину ціни.
      </p>
      <div className="flex flex-col space-y-3">
        {refunds.map((r) => (
          <div key={r.id} className="rounded-xl border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between space-x-3">
              <span className="text-heading font-semibold">{r.displayName}</span>
              <span className="font-geologica text-heading tabular-nums">{formatUah(r.amountUah)}</span>
            </div>
            <div className="text-subtle text-xs mt-1">
              {TYPE_LABEL[r.trainingType]} {ddmm(r.localDate)} о {r.slotTime} ·{" "}
              {r.method === "LIQPAY"
                ? "оплачено онлайн: поверніть у кабінеті оплат"
                : "оплачено готівкою: віддайте в руки"}
            </div>
            <button
              type="button"
              onClick={() => done(r.id)}
              disabled={busyId === r.id}
              className="btn-primary w-full py-3.5 rounded-lg font-semibold mt-4 transition-colors disabled:opacity-60"
            >
              Повернено {formatUah(r.amountUah)}
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
