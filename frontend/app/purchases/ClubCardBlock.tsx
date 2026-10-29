import { MyPurchases } from "@/lib/api";
import { ddmm } from "@/lib/dates";
import { Badge } from "@/components/ui/Badge";

// The club card: what it is, a status badge, and one line on what happens next
export function ClubCardBlock({ data }: { data: MyPurchases }) {
  const { card, lastCard } = data;
  const [badge, badgeText, label, hint] = card
    ? card.state === "active"
      ? ["ok" as const, "Діє", card.label, `До ${ddmm(card.validUntil!)}`]
      : [
          "warn" as const,
          "Чекає активації",
          card.label,
          `Тренер активує клубну карту, коли прийдете в зал. Встигніть до ${ddmm(card.activateBy)}`,
        ]
    : lastCard?.state === "burned"
      ? ["danger" as const, "Згоріла", lastCard.label, "Не активована вчасно. Купіть нову, щоб займатися в залі"]
      : lastCard?.state === "expired"
        ? ["danger" as const, "Закінчилась", lastCard.label, `Діяла до ${ddmm(lastCard.validUntil!)}`]
        : ["none" as const, "Немає", null, "Потрібна, щоб займатися в залі і з тренером"];

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between space-x-3">
        <span className="text-heading font-semibold">Клубна карта</span>
        <Badge tone={badge} size="status" className="whitespace-nowrap">
          {badgeText}
        </Badge>
      </div>
      {label && <p className="text-body mt-2">{label}</p>}
      <p className="text-subtle text-xs mt-2">{hint}</p>
    </div>
  );
}
