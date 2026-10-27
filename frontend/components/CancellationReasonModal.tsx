"use client";
import { useState, useRef, useEffect } from "react";
import { api, CancelFeePreview } from "@/lib/api";

interface Props {
  action: "cancel" | "switch";
  switchTime?: string;
  slotId?: string; // a cancel: asks what it would cost now (late cancellation)
  onConfirm: (reason: string) => void;
  onDismiss: () => void;
}

// What a late cancellation costs, in words; null = it costs nothing
function feeWarning(p: CancelFeePreview | null) {
  if (!p?.fee) return null;
  if (p.fee === "HALF") return `Тренування згорить, повернемо 50%${p.refundUah ? ` (${p.refundUah} ₴)` : ""}.`;
  return p.single ? "Тренування згорить, гроші не повертаються." : "З абонемента спишеться 1 тренування.";
}

export function CancellationReasonModal({ action, switchTime, slotId, onConfirm, onDismiss }: Props) {
  const [reason, setReason] = useState("");
  const [fee, setFee] = useState<CancelFeePreview | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (action !== "cancel" || !slotId) return;
    api
      .getCancelFee(slotId)
      .then(setFee)
      .catch(() => setFee(null));
  }, [action, slotId]);

  const warning = action === "cancel" ? feeWarning(fee) : null;

  const title = action === "switch" ? `Перенести на ${switchTime}` : "Скасувати запис";

  const prompt = action === "switch" ? "Чому переносите час?" : "Чому скасовуєте запис?";

  const submitLabel = action === "switch" ? `Перенести на ${switchTime}` : "Скасувати запис";

  const canSubmit = reason.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onConfirm(reason.trim());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative w-full max-w-[480px] mx-auto bg-surface rounded-t-[20px] sm:rounded-2xl px-5 pt-6 pb-8 shadow-xl border border-line">
        <h2 className="font-geologica font-semibold text-lg text-heading mb-1">{title}</h2>
        {warning && (
          <p className="text-warn bg-warn-bg border border-warn-line rounded-xl px-3 py-2.5 text-sm mb-4">
            Скасування зараз: {warning.charAt(0).toLowerCase() + warning.slice(1)}
          </p>
        )}
        <p className="text-muted text-sm mb-4">{prompt}</p>

        <textarea
          ref={textareaRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Напишіть причину..."
          className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-body resize-none focus:outline-none focus:border-teal"
        />

        <div className="flex flex-col space-y-2 mt-4">
          <button
            disabled={!canSubmit}
            onClick={handleSubmit}
            className={`w-full py-3 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 ${
              action === "switch" ? "btn-primary" : "btn-danger"
            }`}
          >
            {submitLabel}
          </button>
          <button onClick={onDismiss} className="btn-ghost w-full py-3 rounded-lg border text-sm transition-colors">
            Назад
          </button>
        </div>
      </div>
    </div>
  );
}
