"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The page's navy over everything, the dialog on top. Closes on a click outside it or Escape.
// Focus: on open it goes to the dialog itself (not the first field, which would pop the phone keyboard up) unless
// something inside already took it (an autoFocus field, a focused button); Tab stays inside; on close it goes back
// to what had it before (the button that opened the dialog)
export function Modal({ variant = "sheet", onDismiss, canDismiss = true, labelledBy, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Taken on the first render, before a field inside can take the focus
  const [opener] = useState(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && canDismiss) onDismiss();
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return e.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active) || (e.shiftKey ? active === first || active === panel : active === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
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
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`${PANEL[variant]} focus:outline-none`}
      >
        {children}
      </div>
    </div>
  );
}
