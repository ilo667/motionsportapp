"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

const PANEL = {
  // From the bottom on a phone, centered from `sm`
  sheet:
    "relative w-full max-w-[480px] mx-auto bg-surface rounded-t-[20px] sm:rounded-2xl px-5 pt-6 pb-8 shadow-xl border border-line",
  // Scrolls when taller than the screen
  card: "relative w-full max-w-sm bg-surface border border-line rounded-2xl p-5 space-y-4 max-h-full overflow-y-auto",
};

interface ModalProps {
  variant?: keyof typeof PANEL;
  onDismiss: () => void;
  // false while saving: ignore click outside and Escape
  canDismiss?: boolean;
  labelledBy?: string;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Focus goes to the dialog itself, not the first field (that would pop up the phone keyboard), unless something
// inside took it already. Tab is trapped; on close focus returns to the opener.
export function Modal({ variant = "sheet", onDismiss, canDismiss = true, labelledBy, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Read on the first render, before an autoFocus field inside takes the focus
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
