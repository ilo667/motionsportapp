"use client";
import { useState } from "react";
import { api, SlotView } from "@/lib/api";
import { ensurePushSubscribed } from "@/lib/pushUtils";
import { CancellationReasonModal } from "./CancellationReasonModal";

interface SlotCardProps {
  slot: SlotView;
  allSlots: SlotView[];
  bookingWindowOpen: boolean;
  afterWindow: boolean;
  onMutate: (fn: () => Promise<unknown>) => void;
  onRefresh: () => void;
}

export function SlotCard({
  slot,
  allSlots,
  bookingWindowOpen,
  afterWindow,
  onMutate,
  onRefresh,
}: SlotCardProps) {
  const [modal, setModal] = useState<
    | { action: "cancel" }
    | { action: "switch"; targetSlot: SlotView }
    | null
  >(null);

  const otherSlot = allSlots.find(
    (s) => s.id !== slot.id && s.status === "ACTIVE"
  );
  const canSwitch =
    !!otherSlot && otherSlot.bookedCount < otherSlot.capacity;

  const isFull = slot.bookedCount >= slot.capacity;
  const hasAnyBooking = allSlots.some((s) => s.isMyBooking);

  const cardClass = slot.isMyBooking
    ? "bg-teal/5 border-teal"
    : isFull
    ? "bg-surface border-line"
    : "bg-surface border-line";

  return (
    <>
    <div className={`rounded-[12px] border p-5 ${cardClass}`}>
      <div className="flex items-center justify-between mb-4">
        <span className="font-geologica font-semibold text-[22px] text-heading">
          {slot.slotTime}
        </span>
        <span className="text-muted text-sm">
          {slot.bookedCount}/{slot.capacity} місць
        </span>
      </div>

      {slot.status === "CANCELLED" ? (
        <p className="text-danger text-sm font-medium">Скасовано</p>
      ) : afterWindow ? (
        <p className="text-muted text-sm">Запис закрито</p>
      ) : !bookingWindowOpen ? (
        <p className="text-muted text-sm">Запис відкриється о 14:00</p>
      ) : slot.isMyBooking ? (
        <div className="flex flex-col space-y-2">
          <p className="text-teal font-medium text-sm mb-1">✓ Моє місце</p>
          {canSwitch && (
            <button
              onClick={() => setModal({ action: "switch", targetSlot: otherSlot! })}
              className="btn-secondary w-full py-3 rounded-[8px] border text-sm transition-colors"
            >
              Перейти на {otherSlot!.slotTime}
            </button>
          )}
          <button
            onClick={() => setModal({ action: "cancel" })}
            className="btn-danger w-full py-3 rounded-[8px] text-sm transition-colors"
          >
            Скасувати
          </button>
        </div>
      ) : hasAnyBooking ? (
        <p className="text-muted text-sm">Ви вже записані на інший час</p>
      ) : !isFull ? (
        <button
          onClick={() => onMutate(() => api.book(slot.id))}
          className="btn-primary w-full py-3 rounded-[8px] text-sm transition-colors"
        >
          Записатись
        </button>
      ) : (
        <div className="flex flex-col space-y-2">
          <p className="text-muted text-sm font-medium">Місць немає</p>
          {bookingWindowOpen && (
            slot.isMyVacancyAlert ? (
              <button
                onClick={async () => { await onMutate(() => api.unsubscribeVacancy(slot.id)); onRefresh(); }}
                className="btn-secondary w-full py-3 rounded-[8px] border text-sm transition-colors"
              >
                🔔 Сповіщення увімкнено
              </button>
            ) : (
              <button
                onClick={async () => {
                  await ensurePushSubscribed();
                  await onMutate(() => api.subscribeVacancy(slot.id));
                  onRefresh();
                }}
                className="btn-ghost hover-accent w-full py-3 rounded-[8px] border text-sm transition-colors"
              >
                🔕 Сповістити про вільне місце
              </button>
            )
          )}
        </div>
      )}
    </div>

    {modal && (
      <CancellationReasonModal
        action={modal.action}
        switchTime={modal.action === "switch" ? modal.targetSlot.slotTime : undefined}
        onDismiss={() => setModal(null)}
        onConfirm={async (reason, reasonAt) => {
          setModal(null);
          if (modal.action === "cancel") {
            await onMutate(() => api.cancelBooking(reason, reasonAt));
          } else {
            await onMutate(() => api.switchSlot(modal.targetSlot.id, reason, reasonAt));
            onRefresh();
          }
        }}
      />
    )}
    </>
  );
}