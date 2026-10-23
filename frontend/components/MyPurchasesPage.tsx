"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, AssignedType, MyPurchases } from "@/lib/api";
import { submitLiqPay } from "@/lib/liqpay";
import { PageLayout } from "./PageLayout";
import { PurchaseFlow, formatUah, lineName } from "./PurchaseFlow";

const formatDate = (isoDate: string) => {
  const [, m, d] = isoDate.split("-");
  return `${d}.${m}`;
};

// «Мої покупки»: club card, packages, the purchase that awaits payment, and the way into the purchase flow
export function MyPurchasesPage({ startType }: { startType?: AssignedType }) {
  const router = useRouter();
  const [data, setData] = useState<MyPurchases | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [buying, setBuying] = useState(!!startType);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      api
        .getPurchases()
        .then(setData)
        .catch((err: unknown) => {
          const status = (err as { status?: number }).status;
          if (status === 401 || status === 403) router.push("/login");
          else setLoadError(true);
        }),
    [router],
  );

  useEffect(() => {
    load();
  }, [load]);

  const payPending = async () => {
    if (!data?.pending) return;
    setBusy(true);
    setError("");
    try {
      const checkout = await api.checkoutPurchase(data.pending.id);
      if ("status" in checkout) {
        await load(); // a previous attempt was paid after all
        setBusy(false);
      } else {
        submitLiqPay(checkout);
      }
    } catch {
      setError("Не вдалося перейти до оплати. Спробуйте ще раз.");
      setBusy(false);
    }
  };

  const cancelPending = async () => {
    if (!data?.pending) return;
    setBusy(true);
    setError("");
    try {
      await api.cancelPurchase(data.pending.id);
      await load();
    } catch {
      setError("Не вдалося скасувати. Оновіть сторінку.");
    } finally {
      setBusy(false);
    }
  };

  const action = (
    <Link href="/" className="text-muted text-sm hover:text-body transition-colors">
      До розкладу
    </Link>
  );

  if (data && buying) {
    return (
      <PageLayout variant="top" action={action}>
        <PurchaseFlow
          data={data}
          startType={startType}
          onClose={() => setBuying(false)}
          onCashSent={() => load()}
        />
      </PageLayout>
    );
  }

  const pending = data?.pending;
  return (
    <PageLayout variant="top" loading={!data && !loadError} action={action}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-1">
        Мої покупки
      </h1>
      <p className="text-muted text-xs mb-6">Клубна карта й тренування з тренером</p>

      {loadError && <p className="text-danger text-sm">Не вдалося завантажити покупки.</p>}

      {data && (
        <div className="flex flex-col space-y-3">
          <div className="rounded-xl border border-line bg-surface p-4 flex items-center justify-between space-x-3">
            <span className="text-heading font-medium">Клубна карта</span>
            {data.card ? (
              <span className="text-accent text-sm text-right">
                {data.card.label} · діє до {formatDate(data.card.validUntil)}
              </span>
            ) : (
              <span className="text-danger text-sm">немає</span>
            )}
          </div>

          {data.packages
            .filter((p) => p.left > 0)
            .map((p) => (
              <div key={p.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between space-x-3">
                  <span className="text-heading font-medium">{p.title}</span>
                  <span className="text-accent text-sm tabular-nums">
                    залишилось {p.left} з {p.total}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-line overflow-hidden mt-2">
                  <div className="h-full bg-teal" style={{ width: `${(p.left / p.total) * 100}%` }} />
                </div>
              </div>
            ))}

          {pending && (
            <div className="rounded-xl border-2 border-line bg-surface p-4">
              <div className="flex items-center justify-between space-x-3 mb-2">
                <span className="text-heading font-medium">Очікує оплати</span>
                <span className="font-geologica text-heading tabular-nums">{formatUah(pending.totalUah)}</span>
              </div>
              {pending.lines.map((l) => (
                <p key={lineName(l)} className="text-muted text-sm">
                  {lineName(l)}
                </p>
              ))}
              {pending.method === "CASH" && (
                <p className="text-body text-sm mt-2">Тренер підтвердить, коли отримає готівку.</p>
              )}
              <div className="flex flex-col space-y-2 mt-3">
                {pending.method === "LIQPAY" && (
                  <button
                    onClick={payPending}
                    disabled={busy}
                    className="btn-primary w-full py-3 rounded-lg text-sm transition-colors disabled:opacity-60"
                  >
                    {busy ? "Завантаження..." : "Оплатити"}
                  </button>
                )}
                <button
                  onClick={cancelPending}
                  disabled={busy}
                  className="btn-ghost w-full py-3 rounded-lg border text-sm transition-colors disabled:opacity-60"
                >
                  Скасувати
                </button>
              </div>
            </div>
          )}

          {error && <p className="text-danger text-sm">{error}</p>}

          {!pending && (
            <button
              onClick={() => setBuying(true)}
              className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors mt-3"
            >
              Купити тренування з тренером
            </button>
          )}
        </div>
      )}
    </PageLayout>
  );
}
