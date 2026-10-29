"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, CatalogItem, MyPurchases } from "@/lib/api";
import { submitLiqPay } from "@/lib/liqpay";
import { errorText } from "@/lib/apiErrors";
import { Modal } from "@/components/ui/Modal";
import { formatUah, lineName } from "@/lib/prices";

// «Записатись» without a group pass: buy a single visit or a pass by LiqPay (booked once paid), or pay cash to the
// trainer in the hall (booked right away, the trainer confirms the money)
export function GroupPassModal({
  slotId,
  slotTime,
  onDismiss,
  onBooked,
}: {
  slotId: string;
  slotTime: string;
  onDismiss: () => void;
  onBooked: () => void;
}) {
  const [data, setData] = useState<MyPurchases | null>(null);
  const [step, setStep] = useState<"choose" | "cash" | "booked">("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getPurchases()
      .then(setData)
      .catch(() => setError("Не вдалося завантажити ціни. Спробуйте ще раз."));
  }, []);

  const passes = data?.catalog.groupPasses ?? [];
  const single = passes.find((p) => p.trainingCount === 1);
  const pass = passes.find((p) => (p.trainingCount ?? 0) > 1);

  const buy = async (item: CatalogItem, method: "LIQPAY" | "CASH") => {
    setBusy(true);
    setError("");
    try {
      const { checkout } = await api.createPurchase([item.id], method, slotId);
      if (method === "CASH") {
        setStep("booked");
        setBusy(false);
        onBooked();
      } else if (checkout && !("status" in checkout)) {
        submitLiqPay(checkout);
      }
    } catch (err) {
      setError(errorText(err, "Не вдалося оформити покупку. Спробуйте ще раз."));
      setBusy(false);
    }
  };

  return (
    <Modal onDismiss={onDismiss}>
      {step === "booked" ? (
        <>
          <h2 className="font-geologica font-semibold text-lg text-heading mb-1">Записано на {slotTime}</h2>
          <p className="text-body text-sm mb-4">Оплатіть тренеру в залі, і він підтвердить оплату.</p>
          <button
            onClick={onDismiss}
            className="btn-primary w-full py-3 rounded-lg text-sm font-medium transition-colors"
          >
            Добре
          </button>
        </>
      ) : (
        <>
          <h2 className="font-geologica font-semibold text-lg text-heading mb-1">Групове тренування {slotTime}</h2>
          <div className="mb-4" />

          {!data && !error && <p className="text-muted text-sm">Завантаження...</p>}

          {data && (
            <div className="flex flex-col space-y-2">
              {step === "choose" ? (
                <>
                  {single && (
                    <button
                      onClick={() => buy(single, "LIQPAY")}
                      disabled={busy}
                      className="btn-primary w-full py-3 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
                    >
                      Купити разово · {formatUah(single.amountUah)}
                    </button>
                  )}
                  {pass && (
                    <button
                      onClick={() => buy(pass, "LIQPAY")}
                      disabled={busy}
                      className="btn-primary w-full py-3 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
                    >
                      Купити абонемент · {pass.optionLabel} · {formatUah(pass.amountUah)}
                    </button>
                  )}
                  {data.canPayCash && (
                    <button
                      onClick={() => setStep("cash")}
                      disabled={busy}
                      className="btn-ghost w-full py-3 rounded-lg border text-sm transition-colors disabled:opacity-60"
                    >
                      Оплатити готівкою
                    </button>
                  )}
                </>
              ) : (
                [single, pass]
                  .filter((x): x is CatalogItem => !!x)
                  .map((item) => (
                    <button
                      key={item.id}
                      onClick={() => buy(item, "CASH")}
                      disabled={busy}
                      className="btn-primary w-full py-3 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
                    >
                      {lineName(item)} · {formatUah(item.amountUah)}
                    </button>
                  ))
              )}
            </div>
          )}

          {error && (
            <p className="text-danger text-sm mt-3">
              {error}{" "}
              {error.includes("Мій абонемент") && (
                <Link href="/purchases" className="underline">
                  Відкрити
                </Link>
              )}
            </p>
          )}

          <button
            onClick={() => (step === "cash" ? setStep("choose") : onDismiss())}
            className="btn-ghost w-full py-3 rounded-lg border text-sm transition-colors mt-2"
          >
            Назад
          </button>
        </>
      )}
    </Modal>
  );
}
