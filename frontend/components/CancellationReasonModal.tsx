"use client";
import { useState, useRef, useEffect } from "react";

interface Props {
  action: "cancel" | "switch";
  switchTime?: string;
  onConfirm: (reason: string, reasonAt: Date) => void;
  onDismiss: () => void;
}

export function CancellationReasonModal({ action, switchTime, onConfirm, onDismiss }: Props) {
  const [reason, setReason] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const title =
    action === "switch"
      ? `Перенести на ${switchTime}`
      : "Скасувати запис";

  const prompt =
    action === "switch"
      ? "Чому переносите час?"
      : "Чому скасовуєте запис?";

  const submitLabel =
    action === "switch" ? `Перенести на ${switchTime}` : "Скасувати запис";

  const canSubmit = reason.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onConfirm(reason.trim(), new Date());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative w-full max-w-[480px] mx-auto bg-white rounded-t-[20px] sm:rounded-[16px] px-5 pt-6 pb-8 shadow-xl">
        <h2 className="font-geologica font-semibold text-[18px] text-heading mb-1">
          {title}
        </h2>
        <p className="text-muted text-sm mb-4">{prompt}</p>

        <textarea
          ref={textareaRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Напишіть причину..."
          className="w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 text-sm text-body resize-none focus:outline-none focus:border-teal"
        />

        <div className="flex flex-col space-y-2 mt-4">
          <button
            disabled={!canSubmit}
            onClick={handleSubmit}
            className={`w-full py-3 rounded-[10px] text-sm font-medium transition-colors ${
              action === "switch"
                ? "bg-teal text-white hover:opacity-90 disabled:opacity-40"
                : "bg-danger text-white hover:opacity-90 disabled:opacity-40"
            }`}
          >
            {submitLabel}
          </button>
          <button
            onClick={onDismiss}
            className="w-full py-3 rounded-[10px] border border-line text-muted text-sm hover:bg-surface transition-colors"
          >
            Назад
          </button>
        </div>
      </div>
    </div>
  );
}