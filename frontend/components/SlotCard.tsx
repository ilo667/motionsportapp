"use client";
import { api, SlotView } from "@/lib/api";

interface SlotCardProps {
  slot: SlotView;
  allSlots: SlotView[];
  bookingWindowOpen: boolean;
  afterWindow: boolean;
  onMutate: (fn: () => Promise<unknown>) => void;
}

export function SlotCard({
  slot,
  allSlots,
  bookingWindowOpen,
  afterWindow,
  onMutate,
}: SlotCardProps) {
  const otherSlot = allSlots.find(
    (s) => s.id !== slot.id && s.status === "ACTIVE"
  );
  const canSwitch =
    !!otherSlot && otherSlot.bookedCount < otherSlot.capacity;

  const isFull = slot.bookedCount >= slot.capacity;

  const cardClass = slot.isMyBooking
    ? "bg-teal/5 border-teal"
    : isFull
    ? "bg-surface border-line"
    : "bg-white border-line";

  return (
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
        <span className="inline-block bg-danger/10 text-danger text-sm px-3 py-1 rounded-full">
          Скасовано
        </span>
      ) : afterWindow ? (
        <p className="text-muted text-sm">Запис закрито</p>
      ) : !bookingWindowOpen ? (
        <button
          disabled
          className="w-full py-3 rounded-[8px] bg-surface text-muted text-sm cursor-not-allowed"
        >
          Запис відкриється о 14:00
        </button>
      ) : slot.isMyBooking ? (
        <div className="flex flex-col gap-2">
          <p className="text-teal font-medium text-sm mb-1">✓ Моє місце</p>
          {canSwitch && (
            <button
              onClick={() => onMutate(() => api.switchSlot(otherSlot!.id))}
              className="w-full py-3 rounded-[8px] border border-teal text-teal hover:bg-teal/10 text-sm transition-colors"
            >
              Перейти на {otherSlot!.slotTime}
            </button>
          )}
          <button
            onClick={() => onMutate(() => api.cancelBooking())}
            className="w-full py-3 rounded-[8px] bg-danger text-white hover:opacity-90 text-sm transition-colors"
          >
            Скасувати
          </button>
        </div>
      ) : !isFull ? (
        <button
          onClick={() => onMutate(() => api.book(slot.id))}
          className="w-full py-3 rounded-[8px] bg-teal text-white hover:bg-teal-dark text-sm transition-colors"
        >
          Записатись
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-muted text-sm font-medium">Місць немає</p>
          <button
            disabled
            className="w-full py-3 rounded-[8px] border border-line text-muted text-sm cursor-not-allowed"
          >
            Сповістити про вільне місце
          </button>
        </div>
      )}
    </div>
  );
}