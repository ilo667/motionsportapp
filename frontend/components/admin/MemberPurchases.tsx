"use client";
import { useCallback, useEffect, useState } from "react";
import { api, MemberPurchases as MemberPurchasesData, PriceItem, Purchase } from "@/lib/api";
import { formatUah, lineName } from "@/components/PurchaseFlow";

const formatDate = (isoDate: string) => {
  const [, m, d] = isoDate.split("-");
  return `${d}.${m}`;
};

type Card = MemberPurchasesData["cards"][number];
type Pack = MemberPurchasesData["packages"][number];

// Only the current state's dates exist (a waiting card has no valid_from yet), so build that one label only
const cardDates = (c: Card): string => {
  switch (c.state) {
    case "waiting":
      return `Активувати до ${formatDate(c.activateBy)}, інакше згорить`;
    case "active":
      return `З ${formatDate(c.validFrom!)} по ${formatDate(c.validUntil!)}`;
    case "expired":
      return `Діяла до ${formatDate(c.validUntil!)}`;
    case "burned":
      return `Не активована до ${formatDate(c.activateBy)}`;
  }
};

const packDates = (p: Pack): string => {
  switch (p.state) {
    case "waiting":
      return `почнеться з першого тренування, до ${formatDate(p.activateBy)}`;
    case "active":
      return `діє до ${formatDate(p.validUntil!)}`;
    case "expired":
      return `закінчився ${formatDate(p.validUntil!)}`;
    case "burned":
      return "не почато вчасно, згорів";
    case "used":
      return "використано";
  }
};

const sectionTitle = "text-subtle text-xs font-semibold uppercase tracking-wide mb-2";

const CARD_BADGE: Record<Card["state"], { text: string; className: string }> = {
  waiting: { text: "Чекає", className: "text-warn bg-warn-bg border-warn-line" },
  active: { text: "Діє", className: "text-accent bg-teal/10 border-teal/30" },
  expired: { text: "Закінчилась", className: "text-subtle border-line" },
  burned: { text: "Згоріла", className: "text-danger bg-danger/10 border-danger/30" },
};

const STATUS: Record<Purchase["status"], string> = {
  PENDING: "очікує оплати",
  PAID: "оплачено",
  REJECTED: "відхилено",
  FAILED: "не пройшла",
  EXPIRED: "час минув",
  CANCELLED: "скасовано",
};

// Expanded under a client: their cards (with «Активувати з сьогодні»), packages and purchase history,
// plus «Додати клубну карту з рецепції»
export function MemberPurchases({ memberId, onChanged }: { memberId: string; onChanged: () => void }) {
  const [data, setData] = useState<MemberPurchasesData | null>(null);
  const [failed, setFailed] = useState(false);
  const [cardItems, setCardItems] = useState<PriceItem[] | null>(null);
  const [cardId, setCardId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      api
        .getMemberPurchases(memberId)
        .then(setData)
        .catch(() => setFailed(true)),
    [memberId],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Club card options come from the shared price list
  const openAddCard = () =>
    api
      .getPrices()
      .then(({ items }) => setCardItems(items.filter((i) => i.section === "club_card")))
      .catch(() => setError("Не вдалося завантажити клубні карти"));

  const activate = async (id: string) => {
    setSaving(true);
    setError("");
    try {
      await api.activateClubCard(memberId, id);
      await load();
      onChanged();
    } catch {
      setError("Не вдалося активувати клубну карту");
    } finally {
      setSaving(false);
    }
  };

  const addCard = async (activateNow: boolean) => {
    if (!cardId) return;
    setSaving(true);
    setError("");
    try {
      await api.addClubCard(memberId, cardId, activateNow);
      setCardItems(null);
      setCardId("");
      await load();
      onChanged();
    } catch {
      setError("Не вдалося додати клубну карту");
    } finally {
      setSaving(false);
    }
  };

  if (failed) return <p className="text-danger text-xs">Не вдалося завантажити покупки</p>;
  if (!data) return <p className="text-muted text-xs">Завантаження...</p>;

  return (
    <div className="flex flex-col">
      <section className="pb-4">
        <h3 className={sectionTitle}>Клубна карта</h3>
        {data.cards.length === 0 && <p className="text-subtle">Ще немає</p>}
        <div className="flex flex-col space-y-3">
          {data.cards.map((c) => (
            <div key={c.id} className="flex items-center justify-between space-x-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center -m-1">
                  <span className={`m-1 font-semibold ${c.state === "waiting" || c.state === "active" ? "text-heading" : "text-subtle"}`}>
                    {c.label}
                  </span>
                  <span className={`m-1 text-xs font-semibold border rounded-full px-2 py-0.5 ${CARD_BADGE[c.state].className}`}>
                    {CARD_BADGE[c.state].text}
                  </span>
                </p>
                <p className="text-subtle text-xs mt-1">
                  {cardDates(c)}
                  {c.source === "manual" && " · додано тренером"}
                </p>
              </div>
              {c.state === "waiting" && (
                <button
                  onClick={() => activate(c.id)}
                  disabled={saving}
                  className="btn-primary px-4 py-2.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors disabled:opacity-40"
                >
                  Активувати з сьогодні
                </button>
              )}
            </div>
          ))}
        </div>
        {cardItems ? (
          <div className="flex flex-wrap items-center -m-1 mt-2">
            <select
              aria-label="Клубна карта"
              value={cardId}
              onChange={(e) => setCardId(e.target.value)}
              className="input-field border rounded-lg px-2 py-1.5 text-xs focus:outline-none m-1"
            >
              <option value="">Виберіть клубну карту</option>
              {cardItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {lineName(i)}
                </option>
              ))}
            </select>
            <button
              onClick={() => addCard(true)}
              disabled={!cardId || saving}
              className="btn-primary px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 m-1"
            >
              Додати й активувати з сьогодні
            </button>
            <button
              onClick={() => addCard(false)}
              disabled={!cardId || saving}
              className="btn-ghost px-3 py-1.5 rounded-lg border text-xs transition-colors disabled:opacity-40 m-1"
            >
              Додати
            </button>
            <button onClick={() => setCardItems(null)} className="text-subtle text-xs hover:text-body m-1">
              Скасувати
            </button>
          </div>
        ) : (
          // Only when the client has no club card now (none, ended or burned)
          !data.card && (
            <button onClick={openAddCard} className="text-accent text-xs hover:underline mt-2">
              + Додати клубну карту з рецепції
            </button>
          )
        )}
      </section>

      <section className="py-4 border-t border-line">
        <h3 className={sectionTitle}>Послуги тренера й абонементи</h3>
        {data.packages.length === 0 && <p className="text-subtle">Ще немає</p>}
        <div className="flex flex-col space-y-2">
          {data.packages.map((p) => (
            <div key={p.id} className="flex justify-between space-x-3">
              <span className={p.state === "waiting" || p.state === "active" ? "text-heading" : "text-subtle"}>
                {p.trainingType === "групові" ? `Групові · ${p.title}` : p.title}
                <span className="block text-subtle text-xs">{packDates(p)}</span>
              </span>
              <span className="tabular-nums text-body whitespace-nowrap">
                залишилось {p.left} з {p.total}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="pt-4 border-t border-line">
        <h3 className={sectionTitle}>Історія покупок</h3>
        {data.purchases.length === 0 && <p className="text-subtle">Покупок ще не було</p>}
        {data.purchases.map((p) => (
          <div key={p.id} className="py-1.5 border-b border-line last:border-0">
            <div className="flex justify-between space-x-3">
              <span className="text-heading">{p.lines.map(lineName).join(" + ")}</span>
              <span className="tabular-nums text-heading font-semibold whitespace-nowrap">{formatUah(p.totalUah)}</span>
            </div>
            <p className="text-subtle text-xs">
              {new Date(p.createdAt).toLocaleDateString("uk-UA", { day: "numeric", month: "short", timeZone: "Europe/Kyiv" })}
              {" · "}
              {p.method === "CASH" ? "готівка" : "онлайн"} · {STATUS[p.status]}
              {p.decidedBy && ` · ${p.decidedBy}`}
            </p>
          </div>
        ))}
      </section>
      {error && <p className="text-danger text-xs mt-2">{error}</p>}
    </div>
  );
}
