"use client";
import { useState } from "react";
import { api, AssignedType, CatalogItem, MyPurchases, PurchaseLine, PurchaseMethod } from "@/lib/api";
import { submitLiqPay } from "@/lib/liqpay";

export const formatUah = (v: number) => `${v.toLocaleString("uk-UA")} ₴`;
export const lineName = (l: Pick<PurchaseLine, "title" | "optionLabel">) =>
  l.optionLabel ? `${l.title} · ${l.optionLabel}` : l.title;

type Step = "service" | "club" | "group" | "checkout" | "sent";

// What is being bought: a trainer service (with a club card if none), a club card alone, or a group pass
export type PurchaseMode = "service" | "card" | "group";

const SERVICE_GROUPS: { type: AssignedType; title: string }[] = [
  { type: "персональні", title: "Персональне" },
  { type: "спліт", title: "Спліт" },
];

// Options of one list grouped under their title ("Повний день": 1 / 3 / 6 місяців), in price list order
function groupByTitle(items: CatalogItem[]) {
  const groups: { title: string; items: CatalogItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last?.title === item.title) last.items.push(item);
    else groups.push({ title: item.title, items: [item] });
  }
  return groups;
}

function Option({ item, selected, onSelect }: { item: CatalogItem; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full flex items-center justify-between space-x-3 rounded-xl border px-4 py-3 text-left transition-colors ${
        selected ? "border-teal bg-teal/10" : "border-line bg-surface hover:border-muted"
      }`}
    >
      <span className="text-heading">{item.optionLabel ?? item.title}</span>
      <span className="font-geologica text-heading tabular-nums whitespace-nowrap">{formatUah(item.amountUah)}</span>
    </button>
  );
}

const sectionTitle = "font-geologica font-semibold text-heading uppercase mt-5 mb-2";

// Service → club card (only without a valid one) → summary with LiqPay or cash → «Запит надіслано».
// mode "card" starts at the club card, mode "group" at the group passes
export function PurchaseFlow({
  data,
  mode = "service",
  startType,
  onClose,
  onCashSent,
}: {
  data: MyPurchases;
  mode?: PurchaseMode;
  startType?: AssignedType;
  onClose: () => void;
  onCashSent: () => void;
}) {
  const first: Step = mode === "card" ? "club" : mode === "group" ? "group" : "service";
  const [step, setStep] = useState<Step>(first);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [clubId, setClubId] = useState<string | null>(null);
  const [passId, setPassId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const needsCard = !data.card;
  const service = data.catalog.services.find((s) => s.id === serviceId);
  const club = data.catalog.clubCards.find((c) => c.id === clubId);
  const pass = data.catalog.groupPasses.find((p) => p.id === passId);
  const lines = [club, service, pass].filter((x): x is CatalogItem => !!x);
  const total = lines.reduce((sum, l) => sum + l.amountUah, 0);
  const groups = SERVICE_GROUPS.filter((g) => !startType || g.type === startType);

  const pay = async (method: PurchaseMethod) => {
    setBusy(true);
    setError("");
    try {
      const { checkout } = await api.createPurchase(
        lines.map((l) => l.id),
        method,
      );
      if (method === "CASH") {
        setStep("sent");
        setBusy(false);
      } else if (checkout && !("status" in checkout)) {
        submitLiqPay(checkout);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setError(
        message.includes("unpaid purchase")
          ? "У вас уже є покупка, що очікує оплати. Оплатіть або скасуйте її в «Мої покупки»."
          : "Не вдалося оформити покупку. Спробуйте ще раз.",
      );
      setBusy(false);
    }
  };

  const back = (to: Step | "close") => (
    <button
      onClick={() => (to === "close" ? onClose() : setStep(to))}
      className="text-muted text-sm hover:text-body transition-colors mb-4"
    >
      ← Назад
    </button>
  );

  if (step === "sent") {
    return (
      <div>
        <h1 className="font-geologica font-semibold text-title text-heading uppercase mb-3">Запит надіслано</h1>
        <p className="rounded-xl border border-teal bg-teal/10 px-4 py-3 text-sm text-accent mb-5">
          Тренер побачить запит «оплата готівкою». Віддайте йому гроші на тренуванні, і він підтвердить оплату.
        </p>
        <button
          onClick={() => {
            onCashSent();
            onClose();
          }}
          className="btn-ghost w-full py-3 rounded-lg border text-sm transition-colors"
        >
          До моїх покупок
        </button>
      </div>
    );
  }

  if (step === "checkout") {
    return (
      <div>
        {back(mode === "group" ? "group" : mode === "card" || needsCard ? "club" : "service")}
        <h1 className="font-geologica font-semibold text-title text-heading uppercase mb-1">Оплата</h1>
        <p className="text-muted text-xs mb-4">Перевірте, що купуєте</p>
        <div className="rounded-xl border border-line bg-surface px-4 py-2 mb-4">
          {lines.map((l) => (
            <div key={l.id} className="flex justify-between space-x-3 py-2 border-b border-line">
              <span className="text-body">{lineName(l)}</span>
              <span className="font-geologica text-heading tabular-nums">{formatUah(l.amountUah)}</span>
            </div>
          ))}
          <div className="flex justify-between space-x-3 py-2">
            <span className="text-muted">Разом</span>
            <span className="font-geologica text-heading text-lg tabular-nums">{formatUah(total)}</span>
          </div>
        </div>
        <div className="flex flex-col space-y-2">
          <button
            onClick={() => pay("LIQPAY")}
            disabled={busy}
            className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors disabled:opacity-60"
          >
            {busy ? "Завантаження..." : "Оплатити карткою · LiqPay"}
          </button>
          {data.canPayCash && (
            <button
              onClick={() => pay("CASH")}
              disabled={busy}
              className="btn-ghost w-full py-4 rounded-lg border text-sm transition-colors disabled:opacity-60"
            >
              Оплачу готівкою тренеру
            </button>
          )}
        </div>
        {data.canPayCash && (
          <p className="text-muted text-xs mt-3">
            Готівка: тренер побачить запит і підтвердить, коли отримає гроші. Ціна зафіксована зараз.
          </p>
        )}
        {error && <p className="text-danger text-sm mt-3">{error}</p>}
      </div>
    );
  }

  if (step === "group") {
    return (
      <div>
        {back("close")}
        <h1 className="font-geologica font-semibold text-title text-heading uppercase mb-1">Групові тренування</h1>
        <p className="text-muted text-xs mb-4">
          Діє місяць від першого тренування. Якщо не почати протягом місяця від покупки, згорає.
        </p>
        <div className="flex flex-col space-y-2">
          {data.catalog.groupPasses.map((p) => (
            <Option key={p.id} item={{ ...p, optionLabel: lineName(p) }} selected={p.id === passId} onSelect={() => setPassId(p.id)} />
          ))}
        </div>
        <button
          onClick={() => setStep("checkout")}
          disabled={!passId}
          className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors disabled:opacity-40 mt-5"
        >
          Далі
        </button>
      </div>
    );
  }

  if (step === "club") {
    return (
      <div>
        {back(mode === "card" ? "close" : "service")}
        {mode === "card" ? (
          <>
            <h1 className="font-geologica font-semibold text-title text-heading uppercase mb-3">Клубна карта</h1>
            <p className="rounded-xl border border-line bg-background px-4 py-3 text-sm text-body mb-2">
              Карту активує тренер у залі, з того дня рахується строк. Якщо не активувати протягом місяця від
              покупки, вона згорає.
            </p>
          </>
        ) : (
          <>
            <h1 className="font-geologica font-semibold text-title text-heading uppercase mb-3">Спершу клубна карта</h1>
            <p className="rounded-xl border border-line bg-background px-4 py-3 text-sm text-body mb-2">
              У вас немає діючої клубної карти. Вона потрібна, щоб займатись у залі, і купується окремо від тренувань.
            </p>
          </>
        )}
        {groupByTitle(data.catalog.clubCards).map((g) => (
          <section key={g.title}>
            <h2 className={sectionTitle}>{g.title}</h2>
            <div className="flex flex-col space-y-2">
              {g.items.map((c) => (
                <Option key={c.id} item={c} selected={c.id === clubId} onSelect={() => setClubId(c.id)} />
              ))}
            </div>
          </section>
        ))}
        <button
          onClick={() => setStep("checkout")}
          disabled={!clubId}
          className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors disabled:opacity-40 mt-5"
        >
          Далі
        </button>
      </div>
    );
  }

  return (
    <div>
      {back("close")}
      <h1 className="font-geologica font-semibold text-title text-heading uppercase mb-1">Послуги тренера</h1>
      <p className="text-muted text-xs mb-4">Ціна без урахування вартості клубної карти</p>
      {groups.map((g) => (
        <section key={g.type}>
          <h2 className={sectionTitle}>{g.title}</h2>
          <div className="flex flex-col space-y-2">
            {data.catalog.services
              .filter((s) => s.trainingType === g.type)
              .map((s) => (
                <Option key={s.id} item={s} selected={s.id === serviceId} onSelect={() => setServiceId(s.id)} />
              ))}
          </div>
        </section>
      ))}
      <button
        onClick={() => {
          setClubId(null);
          setStep(needsCard ? "club" : "checkout");
        }}
        disabled={!serviceId}
        className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors disabled:opacity-40 mt-5"
      >
        Далі
      </button>
    </div>
  );
}
