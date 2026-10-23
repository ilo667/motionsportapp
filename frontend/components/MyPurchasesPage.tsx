"use client";
import { ReactNode, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, AssignedType, CatalogItem, MyPurchases } from "@/lib/api";
import { submitLiqPay } from "@/lib/liqpay";
import { PageLayout } from "./PageLayout";
import { PurchaseFlow, PurchaseMode, formatUah, lineName } from "./PurchaseFlow";

const formatDate = (isoDate: string) => {
  const [, m, d] = isoDate.split("-");
  return `${d}.${m}`;
};

const sectionTitle = "font-geologica font-semibold text-heading uppercase text-xs tracking-wide";

// «від 250 ₴»: the cheapest option of a list
const fromPrice = (items: CatalogItem[]) =>
  items.length ? `від ${formatUah(Math.min(...items.map((i) => i.amountUah)))}` : "";

const iconProps = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
const PersonIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="7" r="4" />
    <path d="M5 21c0-4 3-6 7-6s7 2 7 6" />
  </svg>
);
const GroupIcon = () => (
  <svg {...iconProps}>
    <circle cx="8" cy="8" r="3" />
    <circle cx="16" cy="8" r="3" />
    <path d="M2 20c0-3 3-5 6-5s6 2 6 5" />
    <path d="M14 15c3 0 8 1 8 5" />
  </svg>
);
const CardIcon = () => (
  <svg {...iconProps}>
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <path d="M3 10h18" />
  </svg>
);

function BuyTile({ icon, title, price, onClick }: { icon: ReactNode; title: string; price: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 min-w-0 rounded-xl border border-line bg-surface p-4 text-left hover:border-subtle transition-colors"
    >
      <span className="block text-accent">{icon}</span>
      <span className="block text-heading font-semibold mt-3">{title}</span>
      <span className="block text-subtle text-xs mt-0.5">{price}</span>
    </button>
  );
}

const BADGE = {
  waiting: "text-warn bg-warn-bg border-warn-line",
  active: "text-accent bg-teal/10 border-teal/30",
  ended: "text-danger bg-danger/10 border-danger/30",
  none: "text-subtle bg-background border-line",
};

// The club card: what it is, a status badge, and one line on what happens next
function ClubCardBlock({ data }: { data: MyPurchases }) {
  const { card, lastCard } = data;
  const [badge, badgeText, label, hint] = card
    ? card.state === "active"
      ? [BADGE.active, "Діє", card.label, `До ${formatDate(card.validUntil!)}`]
      : [
          BADGE.waiting,
          "Чекає активації",
          card.label,
          `Тренер активує клубну карту, коли прийдете в зал. Встигніть до ${formatDate(card.activateBy)}`,
        ]
    : lastCard?.state === "burned"
      ? [BADGE.ended, "Згоріла", lastCard.label, "Не активована вчасно. Купіть нову, щоб займатися в залі"]
      : lastCard?.state === "expired"
        ? [BADGE.ended, "Закінчилась", lastCard.label, `Діяла до ${formatDate(lastCard.validUntil!)}`]
        : [BADGE.none, "Немає", null, "Потрібна, щоб займатися в залі і з тренером"];

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between space-x-3">
        <span className="text-heading font-semibold">Клубна карта</span>
        <span className={`text-xs font-semibold border rounded-full px-2.5 py-1 whitespace-nowrap ${badge}`}>
          {badgeText}
        </span>
      </div>
      {label && <p className="text-body mt-2">{label}</p>}
      <p className="text-subtle text-xs mt-2">{hint}</p>
    </div>
  );
}

// «Мої покупки»: club card, packages and group passes, the purchase that awaits payment, and the ways into the
// purchase flow (trainer service, club card alone, group pass)
export function MyPurchasesPage({ startType }: { startType?: AssignedType }) {
  const router = useRouter();
  const [data, setData] = useState<MyPurchases | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [buying, setBuying] = useState<PurchaseMode | null>(startType ? "service" : null);
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
          mode={buying}
          startType={startType}
          onClose={() => setBuying(null)}
          onCashSent={() => load()}
        />
      </PageLayout>
    );
  }

  const pending = data?.pending;
  return (
    <PageLayout variant="top" loading={!data && !loadError} action={action}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">
        Мої покупки
      </h1>

      {loadError && <p className="text-danger text-base">Не вдалося завантажити покупки.</p>}

      {data && (
        <div className="flex flex-col space-y-3">
          <h2 className={sectionTitle}>Що у вас є</h2>
          <ClubCardBlock data={data} />

          {data.packages
            .filter((p) => p.state === "waiting" || p.state === "active")
            .map((p) => (
              <div key={p.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between space-x-3">
                  <span className="text-heading font-semibold">
                    {p.trainingType === "групові" ? `Групові · ${p.title}` : p.title}
                  </span>
                  <span className="text-accent text-base tabular-nums">
                    {p.left} з {p.total}
                  </span>
                </div>
                <p className="text-subtle text-xs mt-1">
                  {p.state === "active"
                    ? `Діє до ${formatDate(p.validUntil!)}`
                    : `Почнеться з першого тренування. Встигніть до ${formatDate(p.activateBy)}`}
                </p>
                <div className="h-1.5 rounded-full bg-line overflow-hidden mt-2">
                  <div className="h-full bg-teal" style={{ width: `${(p.left / p.total) * 100}%` }} />
                </div>
              </div>
            ))}

          {data.packages
            .filter((p) => (p.state === "burned" || p.state === "expired") && p.left > 0)
            .map((p) => (
              <p key={p.id} className="text-subtle text-xs px-1">
                {p.trainingType === "групові" ? `Групові · ${p.title}` : p.title}: {p.left} з {p.total}{" "}
                {p.state === "burned" ? "згоріли (не почато вчасно)" : `згоріли, строк до ${formatDate(p.validUntil!)}`}
              </p>
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
            <>
              <h2 className={`${sectionTitle} pt-3`}>Купити</h2>
              <button
                onClick={() => setBuying("service")}
                className="btn-primary w-full rounded-xl p-4 text-left transition-colors"
              >
                <PersonIcon />
                <span className="block font-semibold mt-3">З тренером</span>
                <span className="block text-xs mt-0.5">Персональні та спліт · {fromPrice(data.catalog.services)}</span>
              </button>
              <div className="flex space-x-3">
                <BuyTile
                  icon={<GroupIcon />}
                  title="Групові"
                  price={fromPrice(data.catalog.groupPasses)}
                  onClick={() => setBuying("group")}
                />
                <BuyTile
                  icon={<CardIcon />}
                  title="Клубна карта"
                  price={fromPrice(data.catalog.clubCards)}
                  onClick={() => setBuying("card")}
                />
              </div>
            </>
          )}
        </div>
      )}
    </PageLayout>
  );
}
