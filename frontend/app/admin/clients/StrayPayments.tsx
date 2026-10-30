"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, StrayPayment } from "@/lib/api";
import { kyivDateTime } from "@/lib/dates";
import { formatUah, lineName } from "@/lib/prices";

// Top of «Клієнти»: money that came after the purchase was cancelled or expired, so the client got nothing.
// The trainer gives the purchase by hand or has the money refunded, then presses «Розібрано»
export function StrayPayments() {
  const [items, setItems] = useState<StrayPayment[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Not loaded: the block shows that, since hiding it would hide money waiting to be sorted out
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(
    () =>
      api
        .getStrayPayments()
        .then((list) => {
          setItems(list);
          setLoadFailed(false);
        })
        .catch(() => setLoadFailed(true)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  if (items.length === 0 && !loadFailed) return null;

  const handled = async (id: string) => {
    setBusyId(id);
    setError("");
    try {
      await api.markPaymentHandled(id);
    } catch {
      setError("Не вдалося зберегти. Оновіть сторінку й спробуйте ще раз.");
    } finally {
      setBusyId(null);
      load();
    }
  };

  return (
    <section>
      <h2 className="font-geologica font-semibold text-heading uppercase mb-1">Гроші без покупки</h2>
      <p className="text-muted text-xs mb-3">
        Оплата прийшла, коли покупку вже скасовано, тож клієнт нічого не отримав. Видайте покупку вручну або поверніть
        гроші.
      </p>
      {loadFailed && <p className="text-danger text-xs mb-3">Не вдалося завантажити. Оновіть сторінку.</p>}
      <div className="flex flex-col space-y-3">
        {items.map((p) => (
          <div key={p.paymentId} className="rounded-xl border border-warn-line bg-warn-bg p-4">
            <div className="flex items-baseline justify-between space-x-3">
              <Link href={`/admin/clients/${p.memberId}`} className="text-heading font-semibold hover:underline">
                {p.displayName} ›
              </Link>
              <span className="text-heading font-semibold whitespace-nowrap">{formatUah(p.amountUah)}</span>
            </div>
            <div className="text-subtle text-xs mt-1">{kyivDateTime(p.paidAt)}</div>
            {p.lines.map((l) => (
              <div key={lineName(l)} className="text-body text-xs mt-1">
                {l.section === "club_card" ? `Клубна карта · ${lineName(l)}` : lineName(l)}
              </div>
            ))}
            {p.liqpayPaymentId && (
              <div className="text-subtle text-xs mt-2">Номер платежу для повернення: {p.liqpayPaymentId}</div>
            )}
            <button
              onClick={() => handled(p.paymentId)}
              disabled={busyId === p.paymentId}
              className="w-full py-3 rounded-xl border border-line text-heading font-semibold mt-4 hover:bg-surface transition-colors disabled:opacity-60"
            >
              Розібрано
            </button>
          </div>
        ))}
      </div>
      {error && <p className="text-danger text-xs mt-2">{error}</p>}
    </section>
  );
}
