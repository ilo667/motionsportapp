"use client";
import { useState } from "react";
import { api, SlotView } from "@/lib/api";
import { ensurePushSubscribed } from "@/lib/pushUtils";
import { CancellationReasonModal } from "./CancellationReasonModal";
import { GroupPassModal } from "./GroupPassModal";
import { kyivTime } from "@/lib/kyivTime";

// Group slot (any time the trainer set; paid: a group pass, else «Записатись» offers to buy one). Booking,
// cancelling and switching end when the training starts. Assigned: AssignedSlotCard
interface SlotCardProps {
  slot: SlotView;
  allSlots: SlotView[];
  groupPassLeft: number;
  bookingWindowOpen: boolean;
  afterWindow: boolean;
  bookingOpenAt: string | null;
  onMutate: (fn: () => Promise<unknown>) => void;
  onRefresh: () => void;
}

export function SlotCard({
  slot,
  allSlots,
  groupPassLeft,
  bookingWindowOpen,
  afterWindow,
  bookingOpenAt,
  onMutate,
  onRefresh,
}: SlotCardProps) {
  const [modal, setModal] = useState<{ action: "cancel" } | { action: "switch"; targetSlot: SlotView } | null>(null);
  const [buying, setBuying] = useState(false);

  // A move goes to another training of the day that has not started yet
  const otherSlot = allSlots.find((s) => s.id !== slot.id && s.status === "ACTIVE" && !s.started);
  const canSwitch = !!otherSlot && otherSlot.bookedCount < otherSlot.capacity;

  const isFull = slot.bookedCount >= slot.capacity;
  const hasAnyBooking = allSlots.some((s) => s.isMyBooking);

  const cardClass = slot.isMyBooking
    ? "bg-teal/5 border-teal"
    : isFull
      ? "bg-surface border-line"
      : "bg-surface border-line";

  return (
    <>
      <div className={`rounded-xl border-2 p-5 ${cardClass}`}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-geologica font-semibold text-title text-heading">{slot.slotTime}</span>
          <span className="text-muted text-sm">
            {slot.bookedCount}/{slot.capacity} місць
          </span>
        </div>

        {slot.status === "CANCELLED" ? (
          <p className="text-danger text-sm font-medium">Скасовано</p>
        ) : afterWindow || slot.started ? (
          <p className="text-muted text-sm">Запис закрито</p>
        ) : !bookingWindowOpen ? (
          <p className="text-muted text-sm">
            {bookingOpenAt ? `Запис відкриється о ${kyivTime(bookingOpenAt)}` : "Запис ще не відкрився"}
          </p>
        ) : slot.isMyBooking ? (
          <div className="flex flex-col space-y-2">
            {canSwitch && (
              <button
                onClick={() => setModal({ action: "switch", targetSlot: otherSlot! })}
                className="btn-secondary w-full py-3 rounded-lg border text-sm transition-colors"
              >
                Перейти на {otherSlot!.slotTime}
              </button>
            )}
            <button
              onClick={() => setModal({ action: "cancel" })}
              className="btn-danger w-full py-3 rounded-lg text-sm transition-colors"
            >
              Скасувати
            </button>
          </div>
        ) : hasAnyBooking && !isFull ? (
          <p className="text-muted text-sm">Ви вже записані на інший час</p>
        ) : !isFull ? (
          <button
            onClick={() => (groupPassLeft > 0 ? onMutate(() => api.book(slot.id)) : setBuying(true))}
            className="btn-primary w-full py-3 rounded-lg text-sm transition-colors"
          >
            Записатись
          </button>
        ) : (
          // Full slot. Also offered to a member booked on the other time: when a seat frees up,
          // their own card shows "Перейти на …"
          <div className="flex flex-col space-y-2">
            <p className="text-muted text-sm font-medium">Місць немає</p>
            {bookingWindowOpen &&
              (slot.isMyVacancyAlert ? (
                <button
                  onClick={async () => {
                    await onMutate(() => api.unsubscribeVacancy(slot.id));
                    onRefresh();
                  }}
                  className="btn-secondary w-full py-3 rounded-lg border text-sm transition-colors"
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
                  className="btn-ghost hover-accent w-full py-3 rounded-lg border text-sm transition-colors"
                >
                  🔕 Сповістити про вільне місце
                </button>
              ))}
          </div>
        )}
      </div>

      {buying && (
        <GroupPassModal
          slotId={slot.id}
          slotTime={slot.slotTime}
          onDismiss={() => setBuying(false)}
          onBooked={onRefresh}
        />
      )}

      {modal && (
        <CancellationReasonModal
          action={modal.action}
          switchTime={modal.action === "switch" ? modal.targetSlot.slotTime : undefined}
          onDismiss={() => setModal(null)}
          onConfirm={async (reason) => {
            setModal(null);
            if (modal.action === "cancel") {
              await onMutate(() => api.cancelBooking(slot.id, reason));
            } else {
              await onMutate(() => api.switchSlot(modal.targetSlot.id, reason));
              onRefresh();
            }
          }}
        />
      )}
    </>
  );
}
