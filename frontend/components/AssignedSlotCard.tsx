"use client";
import { useState } from "react";
import Link from "next/link";
import { api, AssignedSlotView } from "@/lib/api";
import { CancellationReasonModal } from "./CancellationReasonModal";

const TYPE_LABELS: Record<AssignedSlotView["trainingType"], string> = {
  персональні: "Персональне",
  спліт: "Спліт",
};

function formatDay(localDate: string): string {
  return new Intl.DateTimeFormat("uk-UA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Kyiv",
  }).format(new Date(localDate + "T12:00:00"));
}

interface AssignedSlotCardProps {
  slot: AssignedSlotView;
  onMutate: (fn: () => Promise<unknown>) => void;
}

// Personal / split the trainer assigned to this member. The member is booked already; the training is paid
// from a package when the trainer marks attendance. No package left → «Оплатити» opens the purchase flow
// «1 тренування», «3 тренування», «8 тренувань»
function trainingsLeft(n: number) {
  const tens = n % 100;
  const ones = n % 10;
  return `${n} ${tens < 11 || tens > 14 ? (ones >= 1 && ones <= 4 ? "тренування" : "тренувань") : "тренувань"}`;
}

export function AssignedSlotCard({ slot, onMutate }: AssignedSlotCardProps) {
  const [cancelOpen, setCancelOpen] = useState(false);

  return (
    <>
      <div
        className={`rounded-xl border-2 p-5 ${slot.isMyBooking ? "bg-teal/5 border-teal" : "bg-surface border-line"}`}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <span className="font-geologica font-semibold text-title text-heading">{slot.slotTime}</span>
            <p className="text-muted text-xs capitalize mt-1">{formatDay(slot.localDate)}</p>
          </div>
          <div className="text-right">
            <span className="text-sm text-body">{TYPE_LABELS[slot.trainingType]}</span>
            {slot.trainingType === "спліт" && (
              <p className="text-muted text-xs mt-1">
                {slot.bookedCount}/{slot.capacity} місць
              </p>
            )}
          </div>
        </div>

        {!slot.isMyBooking ? (
          <p className="text-muted text-sm">Ви скасували це тренування</p>
        ) : (
          <div className="flex flex-col space-y-2">
            {slot.spent ? (
              <p className="text-sm text-body">оплачено</p>
            ) : slot.packageLeft > 0 ? (
              <p className="text-sm text-body">Залишилось {trainingsLeft(slot.packageLeft)}</p>
            ) : (
              <Link
                href={`/purchases?type=${encodeURIComponent(slot.trainingType)}`}
                className="btn-primary w-full py-3 rounded-lg text-sm text-center transition-colors"
              >
                Оплатити
              </Link>
            )}
            {slot.started ? (
              <p className="text-muted text-sm">Тренування вже почалося</p>
            ) : (
              <button
                onClick={() => setCancelOpen(true)}
                className="btn-danger w-full py-3 rounded-lg text-sm transition-colors"
              >
                Скасувати
              </button>
            )}
          </div>
        )}
      </div>

      {cancelOpen && (
        <CancellationReasonModal
          action="cancel"
          slotId={slot.id}
          onDismiss={() => setCancelOpen(false)}
          onConfirm={async (reason) => {
            setCancelOpen(false);
            await onMutate(() => api.cancelBooking(slot.id, reason));
          }}
        />
      )}
    </>
  );
}
