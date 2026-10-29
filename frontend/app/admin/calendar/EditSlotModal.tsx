"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, AdminMember, CalendarSlot, Cancellation } from "@/lib/api";
import { TYPE_LABEL } from "@/lib/trainingTypes";
import { longDay } from "@/lib/dates";
import { Modal } from "@/components/ui/Modal";
import { CancellationList } from "@/components/admin/CancellationList";
import { memberLabel } from "./memberLabel";
import { MemberPickers } from "./MemberPickers";
import { fieldsFor, useSave } from "./slotForm";

// A clicked training: who is on it and who cancelled, change the members of a personal / split one, cancel it.
// Mounted per training (key = slotId): `slot` may be swapped for a fresher copy while it is open
export function EditSlotModal({
  slot,
  repeatsWeekly,
  members,
  onDone,
  onClose,
}: {
  slot: CalendarSlot;
  repeatsWeekly: boolean;
  members: AdminMember[];
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [memberIds, setMemberIds] = useState(() =>
    fieldsFor(
      slot.trainingType,
      slot.members.map((m) => m.id),
    ),
  );
  const { saving, error, setError, run } = useSave(onDone);
  // null while loading
  const [cancellations, setCancellations] = useState<Cancellation[] | null>(null);

  useEffect(() => {
    api
      .getSlotCancellations(slot.slotId)
      .then(setCancellations)
      .catch(() => setCancellations([]));
  }, [slot.slotId]);

  const assigned = slot.trainingType !== "групові";
  // The trainer's own and unassigned clients, plus anyone already on this training (another trainer's client
  // must not silently disappear from the picker and be dropped on save)
  const pickerMembers: { id: string; displayName: string; memberCode?: string }[] = [
    ...members,
    ...slot.members.filter((sm) => !members.some((m) => m.id === sm.id)),
  ];

  const handleSaveMembers = () => {
    if (!memberIds[0]) return setError("Виберіть людину");
    return run(
      () => api.updateSlotMembers(slot.slotId, memberIds.filter(Boolean)),
      "Помилка збереження. Спробуйте ще раз.",
    );
  };

  const handleCancelSlot = () => run(() => api.cancelSlot(slot.slotId), "Помилка. Спробуйте ще раз.");

  return (
    <Modal variant="card" onDismiss={onClose} labelledBy="calendar-modal-title">
      <div>
        <p className="text-muted text-xs uppercase tracking-wide mb-1">{longDay(slot.localDate)}</p>
        <p id="calendar-modal-title" className="font-geologica font-semibold text-heading">
          {`${TYPE_LABEL[slot.trainingType]} ${slot.slotTime}`}
        </p>
        {!assigned && (
          <p className="text-muted text-xs mt-1">
            Записано {slot.bookedCount} з {slot.capacity}
          </p>
        )}
        {repeatsWeekly && (
          <p className="text-muted text-xs mt-1">
            ↻ Повторюється щотижня. «Скасувати» прибере лише цей день; щоб прибрати щотижневе, відкрийте{" "}
            <Link href="/admin/schedule" className="text-accent hover:underline">
              «Розклад групових»
            </Link>
          </p>
        )}
      </div>

      {assigned && slot.members.length > 0 && (
        <ul className="space-y-1">
          {slot.members.map((m) => {
            const label = memberLabel(m);
            return (
              <li key={m.id} className="flex items-center justify-between text-sm">
                <span className="text-body">{m.displayName}</span>
                <span className={label.className}>{label.text}</span>
              </li>
            );
          })}
        </ul>
      )}

      {cancellations && <CancellationList title="Скасували" items={cancellations} withDate />}

      {assigned && (
        <MemberPickers
          type={slot.trainingType}
          memberIds={memberIds}
          setMemberIds={setMemberIds}
          members={pickerMembers}
        />
      )}

      {error && <p className="text-danger text-sm">{error}</p>}

      <div className="flex flex-col space-y-2">
        {assigned && (
          <button
            onClick={handleSaveMembers}
            disabled={saving}
            className="btn-primary w-full py-3 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
          >
            {saving ? "Зачекайте..." : "Зберегти"}
          </button>
        )}
        <button
          onClick={handleCancelSlot}
          disabled={saving}
          className="btn-ghost hover-danger w-full py-3 rounded-lg border text-sm transition-colors disabled:opacity-60"
        >
          Скасувати тренування {slot.slotTime}
        </button>
        <button onClick={onClose} className="text-muted text-sm py-2 transition-colors hover:text-body">
          Закрити
        </button>
      </div>
    </Modal>
  );
}
