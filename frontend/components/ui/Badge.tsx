import type { ReactNode } from "react";

// ok = active, warn = waiting or frozen, danger = ended or cancelled, none = grey
const TONE = {
  ok: "text-accent bg-teal/10 border-teal/30",
  warn: "text-warn bg-warn-bg border-warn-line",
  danger: "text-danger bg-danger/10 border-danger/30",
  none: "text-subtle bg-background border-line",
};

const SIZE = {
  // States: card, package, freeze
  status: "font-semibold px-2.5 py-1",
  // Small tags next to a name or time
  tag: "px-2 py-0.5",
};

export type BadgeTone = keyof typeof TONE;

export function Badge({
  tone = "none",
  size = "tag",
  className = "",
  children,
}: {
  tone?: BadgeTone;
  size?: keyof typeof SIZE;
  className?: string;
  children: ReactNode;
}) {
  return <span className={`text-xs border rounded-full ${SIZE[size]} ${TONE[tone]} ${className}`}>{children}</span>;
}
