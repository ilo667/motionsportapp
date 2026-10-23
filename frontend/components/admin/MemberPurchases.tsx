"use client";
import { useCallback, useEffect, useState } from "react";
import { api, MemberPurchases as MemberPurchasesData, PriceItem, Purchase } from "@/lib/api";
import { formatUah, lineName } from "@/components/PurchaseFlow";

const formatDate = (isoDate: string) => {
  const [, m, d] = isoDate.split("-");
  return `${d}.${m}`;
};

const STATUS: Record<Purchase["status"], string> = {
  PENDING: "очікує оплати",
  PAID: "оплачено",
  REJECTED: "відхилено",
  FAILED: "не пройшла",
  EXPIRED: "час минув",
  CANCELLED: "скасовано",
};

// Expanded under a client: their cards, packages and purchase history, plus «Додати карту вручну»
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
      .catch(() => setError("Не вдалося завантажити карти"));

  const addCard = async () => {
    if (!cardId) return;
    setSaving(true);
    setError("");
    try {
      await api.addClubCard(memberId, cardId);
      setCardItems(null);
      setCardId("");
      await load();
      onChanged();
    } catch {
      setError("Не вдалося додати карту");
    } finally {
      setSaving(false);
    }
  };

  if (failed) return <p className="text-danger text-xs">Не вдалося завантажити покупки</p>;
  if (!data) return <p className="text-muted text-xs">Завантаження...</p>;

  return (
    <div className="flex flex-col space-y-4 text-sm">
      <div>
        <h3 className="text-muted text-xs uppercase tracking-wide mb-1">Клубна карта</h3>
        {data.cards.length === 0 && <p className="text-muted">Немає</p>}
        {data.cards.map((c) => (
          <p key={`${c.label}-${c.validFrom}`} className={c.validUntil === data.card?.validUntil ? "text-accent" : "text-muted"}>
            {c.label} · {formatDate(c.validFrom)} – {formatDate(c.validUntil)}
            {c.source === "manual" && " · додано вручну"}
          </p>
        ))}
        {cardItems ? (
          <div className="flex items-center space-x-2 mt-2">
            <select
              aria-label="Клубна карта"
              value={cardId}
              onChange={(e) => setCardId(e.target.value)}
              className="input-field border rounded-lg px-2 py-1.5 text-sm focus:outline-none"
            >
              <option value="">Виберіть карту</option>
              {cardItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {lineName(i)}
                </option>
              ))}
            </select>
            <button
              onClick={addCard}
              disabled={!cardId || saving}
              className="btn-primary px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
            >
              Додати
            </button>
            <button onClick={() => setCardItems(null)} className="text-muted text-xs hover:text-body">
              Скасувати
            </button>
          </div>
        ) : (
          <button onClick={openAddCard} className="text-accent text-xs hover:underline mt-1">
            + Додати карту вручну
          </button>
        )}
        <p className="text-muted text-xs mt-1">Для карти, купленої на рецепції. Діє від сьогодні.</p>
      </div>

      <div>
        <h3 className="text-muted text-xs uppercase tracking-wide mb-1">Тренування з тренером</h3>
        {data.packages.length === 0 && <p className="text-muted">Немає</p>}
        {data.packages.map((p) => (
          <p key={p.id} className={p.left > 0 ? "text-body" : "text-muted"}>
            {p.title} · залишилось <span className="tabular-nums">{p.left} з {p.total}</span>
          </p>
        ))}
      </div>

      <div>
        <h3 className="text-muted text-xs uppercase tracking-wide mb-1">Історія покупок</h3>
        {data.purchases.length === 0 && <p className="text-muted">Покупок ще не було</p>}
        {data.purchases.map((p) => (
          <div key={p.id} className="py-1 border-b border-line last:border-0">
            <div className="flex justify-between space-x-3">
              <span className="text-body">{p.lines.map(lineName).join(" + ")}</span>
              <span className="tabular-nums text-body">{formatUah(p.totalUah)}</span>
            </div>
            <p className="text-muted text-xs">
              {new Date(p.createdAt).toLocaleDateString("uk-UA", { day: "numeric", month: "short", timeZone: "Europe/Kyiv" })}
              {" · "}
              {p.method === "CASH" ? "готівка" : "LiqPay"} · {STATUS[p.status]}
              {p.decidedBy && ` · ${p.decidedBy}`}
            </p>
          </div>
        ))}
      </div>
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );
}
