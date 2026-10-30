import { trainingsCount } from "@/lib/plural";

// Cancelled, paid (spent from a package), covered by a package, or unpaid
export function memberLabel(m: { booked: boolean; spent: boolean; packageLeft: number }) {
  if (!m.booked) return { text: "скасовано", className: "text-muted" };
  if (m.spent) return { text: "оплачено", className: "text-teal" };
  if (m.packageLeft > 0) return { text: `залишилось ${trainingsCount(m.packageLeft)}`, className: "text-teal" };
  return { text: "не оплачено", className: "text-muted" };
}
