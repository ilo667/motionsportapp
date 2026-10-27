"use client";
import { ReactNode, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, AssignedType, CatalogItem, MyFreeze, MyPurchases } from "@/lib/api";
import { submitLiqPay } from "@/lib/liqpay";
import { PageLayout } from "./PageLayout";
import { PurchaseFlow, PurchaseMode, formatUah, lineName } from "./PurchaseFlow";
import { FreezeBlock } from "./FreezeBlock";

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

function BuyTile({
  icon,
  title,
  price,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  price: string;
  onClick: () => void;
}) {
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

// One circle per training: done ones filled with a check, the next one outlined in green, the rest grey.
// Wraps onto a second row for 10–12
function TrainingDots({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex flex-wrap -m-1 mt-3" role="img" aria-label={`Пройдено ${done} з ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`m-1 w-7 h-7 rounded-full flex items-center justify-center ${
            i < done ? "bg-teal" : i === done ? "border-2 border-teal" : "border-2 border-muted/50"
          }`}
        >
          {i < done && (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-on-teal"
              aria-hidden
            >
              <path d="M5 12l5 5 9-10" />
            </svg>
          )}
        </span>
      ))}
    </div>
  );
}

// «Мої покупки»: club card, packages and group passes, the purchase that awaits payment, and the ways into the
// purchase flow (trainer service, club card alone, group pass)
export function MyPurchasesPage({ startType }: { startType?: AssignedType }) {
  const router = useRouter();
  const [data, setData] = useState<MyPurchases | null>(null);
  const [freeze, setFreeze] = useState<MyFreeze | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [buying, setBuying] = useState<PurchaseMode | null>(startType ? "service" : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      Promise.all([api.getPurchases(), api.getMyFreeze()])
        .then(([purchases, myFreeze]) => {
          setData(purchases);
          setFreeze(myFreeze);
        })
        .catch((err: unknown) => {
          const status = (err as { status?: number }).status;
          // 403 = signed in as a trainer: their panel, not the member login
          if (status === 401) router.push("/login");
          else if (status === 403) router.push("/admin");
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
  // No buying ahead: a tile shows only while the member has nothing of that kind left to use
  // (the club card is shown above; trainings with some left are listed above too)
  const hasUnused = (types: string[]) =>
    !!data?.packages.some(
      (p) => types.includes(p.trainingType) && p.left > 0 && (p.state === "waiting" || p.state === "active"),
    );
  const canBuyService = !hasUnused(["персональні", "спліт"]);
  const canBuyGroup = !hasUnused(["групові"]);
  const canBuyCard = !data?.card;
  // Nothing new while frozen or asking to: the freeze moves the dates of what the member has
  const frozen = !!freeze?.freeze;
  return (
    <PageLayout variant="top" loading={!data && !loadError} action={action}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">
        Мій абонемент
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
                <div className="flex items-baseline justify-between space-x-3">
                  <span className="text-heading font-semibold">
                    {p.trainingType === "групові" ? `Групові · ${p.title}` : p.title}
                  </span>
                  <span className="text-subtle text-xs whitespace-nowrap">
                    {p.state === "active"
                      ? `діє до ${formatDate(p.validUntil!)}`
                      : `почати до ${formatDate(p.activateBy)}`}
                  </span>
                </div>
                <TrainingDots done={p.total - p.left} total={p.total} />
                <p className="text-body text-xs mt-3">
                  {p.total - p.left > 0 ? (
                    <>
                      Пройдено <span className="text-accent font-semibold">{p.total - p.left}</span> з {p.total} · ще{" "}
                      {p.left} попереду
                    </>
                  ) : (
                    `Почнеться з першого тренування · ${p.total} попереду`
                  )}
                </p>
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

          {freeze && (frozen || !pending) && <FreezeBlock data={freeze} onChanged={load} />}

          {!pending && !frozen && (canBuyService || canBuyGroup || canBuyCard) && (
            <>
              <h2 className={`${sectionTitle} pt-3`}>Купити</h2>
              {canBuyService && (
                <button
                  onClick={() => setBuying("service")}
                  className="btn-primary w-full rounded-lg p-4 text-left transition-colors"
                >
                  <PersonIcon />
                  <span className="block font-semibold mt-3">З тренером</span>
                  <span className="block text-xs mt-0.5">
                    Персональні та спліт · {fromPrice(data.catalog.services)}
                  </span>
                </button>
              )}
              {(canBuyGroup || canBuyCard) && (
                <div className="flex space-x-3">
                  {canBuyGroup && (
                    <BuyTile
                      icon={<GroupIcon />}
                      title="Групові"
                      price={fromPrice(data.catalog.groupPasses)}
                      onClick={() => setBuying("group")}
                    />
                  )}
                  {canBuyCard && (
                    <BuyTile
                      icon={<CardIcon />}
                      title="Клубна карта"
                      price={fromPrice(data.catalog.clubCards)}
                      onClick={() => setBuying("card")}
                    />
                  )}
                </div>
              )}
            </>
          )}

          <Link href="/prices" className="self-center text-muted text-sm hover:text-body transition-colors pt-3">
            Усі ціни
          </Link>
        </div>
      )}
    </PageLayout>
  );
}
