"use client";
import { useCallback, useEffect, useState } from "react";
import { api, CardState, MemberPurchases as MemberPurchasesData, PassState, PriceItem, Purchase } from "@/lib/api";
import { formatUah, lineName } from "@/components/PurchaseFlow";

const formatDate = (isoDate: string) => {
  const [, m, d] = isoDate.split("-");
  return `${d}.${m}`;
};

type Card = MemberPurchasesData["cards"][number];
type Pack = MemberPurchasesData["packages"][number];

const cardDates = (c: Card): string => {
  const labels: Record<CardState, string> = {
    waiting: `чекає активації, до ${formatDate(c.activateBy)}`,
    active: `${formatDate(c.validFrom!)} – ${formatDate(c.validUntil!)}`,
    expired: `закінчилась ${formatDate(c.validUntil!)}`,
    burned: "не активована, згоріла",
  };
  return labels[c.state];
};

const packDates = (p: Pack): string => {
  const labels: Record<PassState, string> = {
    waiting: `не почато, до ${formatDate(p.activateBy)}`,
    active: `до ${formatDate(p.validUntil!)}`,
    expired: `закінчився ${formatDate(p.validUntil!)}`,
    burned: "не почато, згорів",
    used: "використано",
  };
  return labels[p.state];
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
// plus «Додати карту вручну»
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

  const activate = async (id: string) => {
    setSaving(true);
    setError("");
    try {
      await api.activateClubCard(memberId, id);
      await load();
      onChanged();
    } catch {
      setError("Не вдалося активувати карту");
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
          <div key={c.id} className="flex items-center justify-between space-x-3 py-0.5">
            <p className={c.id === data.card?.id ? "text-accent" : "text-muted"}>
              {c.label} · {cardDates(c)}
              {c.source === "manual" && " · додано вручну"}
            </p>
            {c.state === "waiting" && (
              <button
                onClick={() => activate(c.id)}
                disabled={saving}
                className="btn-primary px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-40"
              >
                Активувати з сьогодні
              </button>
            )}
          </div>
        ))}
        {cardItems ? (
          <div className="flex flex-wrap items-center -m-1 mt-1">
            <select
              aria-label="Клубна карта"
              value={cardId}
              onChange={(e) => setCardId(e.target.value)}
              className="input-field border rounded-lg px-2 py-1.5 text-sm focus:outline-none m-1"
            >
              <option value="">Виберіть карту</option>
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
            <button onClick={() => setCardItems(null)} className="text-muted text-xs hover:text-body m-1">
              Скасувати
            </button>
          </div>
        ) : (
          <button onClick={openAddCard} className="text-accent text-xs hover:underline mt-1">
            + Додати карту вручну
          </button>
        )}
        <p className="text-muted text-xs mt-1">
          Для карти, купленої на рецепції. Не активована протягом місяця, карта згорає.
        </p>
      </div>

      <div>
        <h3 className="text-muted text-xs uppercase tracking-wide mb-1">Пакети й абонементи</h3>
        {data.packages.length === 0 && <p className="text-muted">Немає</p>}
        {data.packages.map((p) => (
          <p key={p.id} className={p.state === "waiting" || p.state === "active" ? "text-body" : "text-muted"}>
            {p.title} · залишилось <span className="tabular-nums">{p.left} з {p.total}</span> · {packDates(p)}
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
              {p.method === "CASH" ? "готівка" : "карткою"} · {STATUS[p.status]}
              {p.decidedBy && ` · ${p.decidedBy}`}
            </p>
          </div>
        ))}
      </div>
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );
}
