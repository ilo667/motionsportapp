"use client";
import { useEffect, type ReactNode } from "react";

const PANEL = {
  // Comes up from the bottom on a phone, centered from `sm`
  sheet:
    "relative w-full max-w-[480px] mx-auto bg-surface rounded-t-[20px] sm:rounded-2xl px-5 pt-6 pb-8 shadow-xl border border-line",
  // A card with a margin around it, scrolls when taller than the screen (calendar, trainers)
  card: "relative w-full max-w-sm bg-surface border border-line rounded-2xl p-5 space-y-4 max-h-full overflow-y-auto",
};

interface ModalProps {
  variant?: keyof typeof PANEL;
  onDismiss: () => void;
  // false while saving: a click outside or Escape doesn't close it then
  canDismiss?: boolean;
  labelledBy?: string; // id of the heading inside
  children: ReactNode;
}

// The page's navy over everything, the dialog on top. Closes on a click outside it or Escape
export function Modal({ variant = "sheet", onDismiss, canDismiss = true, labelledBy, children }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && canDismiss) onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss, canDismiss]);

  return (
    <div
      className={`fixed inset-0 z-50 flex items-end sm:items-center justify-center${variant === "card" ? " p-4" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget && canDismiss) onDismiss();
      }}
    >
      <div className="absolute inset-0 bg-background/70 pointer-events-none" />
      <div role="dialog" aria-modal="true" aria-labelledby={labelledBy} className={PANEL[variant]}>
        {children}
      </div>
    </div>
  );
}
