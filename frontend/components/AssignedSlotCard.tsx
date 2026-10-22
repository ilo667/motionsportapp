"use client";
import { useState } from "react";
import { api, AssignedSlotView } from "@/lib/api";
import { redirectToLiqPay, PRICE_UAH } from "@/lib/liqpay";
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
  onRefresh: () => void;
}

// Personal / split the coach assigned to this member. Paid via LiqPay; payment and cancel until the start
export function AssignedSlotCard({ slot, onMutate, onRefresh }: AssignedSlotCardProps) {
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);

  const handlePay = async () => {
    setPaying(true);
    setPayError("");
    try {
      if (!(await redirectToLiqPay(slot.id))) {
        setPaying(false);
        onRefresh();
      }
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "";
      setPayError(raw.includes("already started") ? "Тренування вже почалося" : "Помилка оплати. Спробуйте ще раз.");
      setPaying(false);
    }
  };

  const isFull = slot.bookedCount >= slot.capacity;
  const payButton = (
    <button
      onClick={handlePay}
      disabled={paying}
      className="btn-primary w-full py-3 rounded-lg text-sm transition-colors disabled:opacity-60"
    >
      {paying ? "Завантаження..." : `Оплатити ${PRICE_UAH} ₴`}
    </button>
  );

  return (
    <>
      <div className={`rounded-xl border-2 p-5 ${slot.isMyBooking ? "bg-teal/5 border-teal" : "bg-surface border-line"}`}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <span className="font-geologica font-semibold text-title text-heading">{slot.slotTime}</span>
            <p className="text-muted text-xs capitalize mt-1">{formatDay(slot.localDate)}</p>
          </div>
          <div className="text-right">
            <span className="text-sm text-body">{TYPE_LABELS[slot.trainingType]}</span>
            {slot.trainingType === "спліт" && (
              <p className="text-muted text-xs mt-1">{slot.bookedCount}/{slot.capacity} місць</p>
            )}
          </div>
        </div>

        {slot.isMyBooking && slot.myPaymentStatus === "PAID" ? (
          <div className="flex flex-col space-y-2">
            <p className="text-xs text-teal text-center">✓ Оплачено</p>
            {!slot.started && (
              <button
                onClick={() => setCancelOpen(true)}
                className="btn-danger w-full py-3 rounded-lg text-sm transition-colors"
              >
                Скасувати
              </button>
            )}
          </div>
        ) : slot.started ? (
          <p className="text-muted text-sm">Тренування вже почалося</p>
        ) : slot.isMyBooking ? (
          <div className="flex flex-col space-y-2">
            <p className="text-xs text-amber-400 text-center">Очікує оплати</p>
            {payButton}
          </div>
        ) : isFull ? (
          <p className="text-muted text-sm font-medium">Місць немає</p>
        ) : (
          payButton
        )}
        {payError && <p className="text-danger text-xs text-center mt-2">{payError}</p>}
      </div>

      {cancelOpen && (
        <CancellationReasonModal
          action="cancel"
          onDismiss={() => setCancelOpen(false)}
          onConfirm={async (reason, reasonAt) => {
            setCancelOpen(false);
            await onMutate(() => api.cancelBooking(slot.id, reason, reasonAt));
          }}
        />
      )}
    </>
  );
}
