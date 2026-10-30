import type { Cancellation, CancelFeePreview } from "@/lib/api";

// Member's warning before cancelling; null = free
export function feeWarning(p: CancelFeePreview | null) {
  if (!p?.fee) return null;
  if (p.fee === "HALF") return `Тренування згорить, повернемо 50%${p.refundUah ? ` (${p.refundUah} ₴)` : ""}.`;
  return p.single ? "Тренування згорить, гроші не повертаються." : "З абонемента спишеться 1 тренування.";
}

// Trainer's fee tag on a cancellation
export function feeLabel(fee: NonNullable<Cancellation["fee"]>) {
  if (fee.waived) return "не списано";
  if (fee.kind === "HALF" && fee.refundUah) {
    return `${fee.refundDone ? "повернено" : "повернути"} ${fee.refundUah} ₴`;
  }
  return "списано";
}
