"use client";
import { useState } from "react";
import { longDay } from "@/lib/dates";

// «Скасувати мої тренування цього дня», asked once more: only this trainer's trainings go, other trainers' stay
export function CancelDayButton({ date, onCancel }: { date: string; onCancel: () => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="border-t border-line pt-5">
      <p className="text-muted text-xs mb-3 uppercase tracking-wide font-medium">Керування днем</p>
      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          className="btn-ghost hover-danger w-full py-3 rounded-lg border text-sm transition-colors"
        >
          Скасувати мої тренування цього дня
        </button>
      ) : (
        <div className="rounded-lg border border-danger bg-danger/5 p-4 space-y-3">
          <p className="text-danger text-sm">
            Скасувати ваші тренування {longDay(date)}? Усі записи на них буде відмінено. Тренування інших тренерів
            залишаться.
          </p>
          <div className="flex space-x-2">
            <button
              onClick={() => {
                setConfirming(false);
                onCancel();
              }}
              className="btn-danger flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors"
            >
              Скасувати
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="btn-ghost flex-1 py-2.5 rounded-lg border text-sm transition-colors"
            >
              Ні
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
