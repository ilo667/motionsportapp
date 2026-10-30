"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, AssignedType, MyFreeze, MyPurchases, statusOf } from "@/lib/api";
import { PageLayout } from "@/components/ui/PageLayout";
import { PurchaseFlow, PurchaseMode } from "./PurchaseFlow";
import { FreezeBlock } from "./FreezeBlock";
import { ddmm } from "@/lib/dates";
import { ClubCardBlock } from "./ClubCardBlock";
import { PackageCard, packageTitle } from "./PackageCard";
import { PendingPurchase } from "./PendingPurchase";
import { BuyBlock } from "./BuyBlock";

const sectionTitle = "font-geologica font-semibold text-heading uppercase text-xs tracking-wide";

export function MyPurchasesPage({ startType }: { startType?: AssignedType }) {
  const router = useRouter();
  const [data, setData] = useState<MyPurchases | null>(null);
  const [freeze, setFreeze] = useState<MyFreeze | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [buying, setBuying] = useState<PurchaseMode | null>(startType ? "service" : null);

  const load = useCallback(
    () =>
      Promise.all([api.getPurchases(), api.getMyFreeze()])
        .then(([purchases, myFreeze]) => {
          setData(purchases);
          setFreeze(myFreeze);
        })
        .catch((err: unknown) => {
          const status = statusOf(err);
          // 403 = a trainer's session
          if (status === 401) router.push("/login");
          else if (status === 403) router.push("/admin");
          else setLoadError(true);
        }),
    [router],
  );

  useEffect(() => {
    load();
  }, [load]);

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
  // No buying while a freeze is open: it moves the dates of what the member has
  const frozen = !!freeze?.freeze;
  return (
    <PageLayout variant="top" loading={!data && !loadError} action={action}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">
        Мій абонемент
      </h1>

      {loadError && (
        <p role="alert" className="text-danger text-base">
          Не вдалося завантажити покупки.
        </p>
      )}

      {data && (
        <div className="flex flex-col space-y-3">
          <h2 className={sectionTitle}>Що у вас є</h2>
          <ClubCardBlock data={data} />

          {data.packages
            .filter((p) => p.state === "waiting" || p.state === "active")
            .map((p) => (
              <PackageCard key={p.id} p={p} />
            ))}

          {data.packages
            .filter((p) => (p.state === "burned" || p.state === "expired") && p.left > 0)
            .map((p) => (
              <p key={p.id} className="text-subtle text-xs px-1">
                {packageTitle(p)}: {p.left} з {p.total}{" "}
                {p.state === "expired" ? `згоріли, строк до ${ddmm(p.validUntil)}` : "згоріли (не почато вчасно)"}
              </p>
            ))}

          {pending && <PendingPurchase pending={pending} onChanged={load} />}

          {freeze && (frozen || !pending) && <FreezeBlock data={freeze} onChanged={load} />}

          {!pending && !frozen && <BuyBlock data={data} titleClass={sectionTitle} onBuy={setBuying} />}

          <Link href="/prices" className="self-center text-muted text-sm hover:text-body transition-colors pt-3">
            Усі ціни
          </Link>
        </div>
      )}
    </PageLayout>
  );
}
