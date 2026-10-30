"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, AdminMember, Trainer, CashRequest, FreezeRequest, CancelRefund } from "@/lib/api";
import { PageLayout } from "@/components/ui/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { CashRequests } from "./CashRequests";
import { StrayPayments } from "./StrayPayments";
import { FreezeRequests } from "./FreezeRequests";
import { CancelRefunds } from "./CancelRefunds";
import { FREQUENT_CANCELLATIONS, NoteCell, PurchaseSummary, TrainerPicker } from "@/components/admin/ClientParts";
import { toAdminLogin } from "@/lib/adminAuth";

export default function ClientsPage() {
  const router = useRouter();
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [myId, setMyId] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [cash, setCash] = useState<CashRequest[]>([]);
  const [freezes, setFreezes] = useState<FreezeRequest[]>([]);
  const [refunds, setRefunds] = useState<CancelRefund[]>([]);

  // A failed refresh after a decision: the lists on screen are stale, so say so
  const [reloadError, setReloadError] = useState(false);

  // After a cash or freeze decision: the request lists and the summaries change
  const reloadPurchases = () => {
    Promise.all([api.getPendingCash(), api.getPendingFreezes(), api.getPendingCancelRefunds(), api.getMembers()])
      .then(([cashList, freezeList, refundList, memberList]) => {
        setCash(cashList);
        setFreezes(freezeList);
        setRefunds(refundList);
        setMembers(memberList);
        setReloadError(false);
      })
      .catch((err: unknown) => {
        if (!toAdminLogin(err, router)) setReloadError(true);
      });
  };

  useEffect(() => {
    Promise.all([
      api.getMembers(),
      api.getTrainers(),
      api.me(),
      api.getPendingCash(),
      api.getPendingFreezes(),
      api.getPendingCancelRefunds(),
    ])
      .then(([memberList, trainerList, me, cashList, freezeList, refundList]) => {
        setMembers(memberList);
        setTrainers(trainerList);
        setMyId(me.id);
        setCash(cashList);
        setFreezes(freezeList);
        setRefunds(refundList);
      })
      .catch((err: unknown) => {
        if (!toAdminLogin(err, router)) setLoadError(true);
      });
  }, [router]);

  const updateNote = (id: string, trainerNote: string | null) =>
    setMembers((prev) => prev?.map((m) => (m.id === id ? { ...m, trainerNote } : m)) ?? null);

  // Given to another trainer: the client leaves this trainer's list
  const updateTrainer = (id: string, trainerId: string) =>
    setMembers(
      (prev) =>
        (trainerId === myId
          ? prev?.map((m) => (m.id === id ? { ...m, trainerId } : m))
          : prev?.filter((m) => m.id !== id)) ?? null,
    );

  const mine = members?.filter((m) => m.trainerId) ?? [];
  const unassigned = members?.filter((m) => !m.trainerId) ?? [];

  const renderTable = (rows: AdminMember[]) => (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-muted text-xs text-left border-b border-line">
          <th className="py-2 pr-3 font-medium w-2/5">Клієнт</th>
          <th className="py-2 pr-3 font-medium">Примітка</th>
          <th className="py-2 font-medium text-right" title="Скасування за останні 30 днів">
            Скасувань
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id} className="align-top border-b border-line">
            <td className="py-3 pr-3">
              {/* Short here; everything else on the client's page */}
              <Link href={`/admin/clients/${m.id}`} className="text-heading hover:text-accent transition-colors">
                {m.displayName} <span className="text-subtle">›</span>
              </Link>
              <div className="text-muted text-xs">{m.memberCode}</div>
              <PurchaseSummary m={m} className="mt-1" />
              <TrainerPicker
                member={m}
                trainers={trainers}
                myId={myId}
                onAssigned={(trainerId) => updateTrainer(m.id, trainerId)}
              />
            </td>
            <td className="py-3 pr-3">
              <NoteCell member={m} onSaved={(note) => updateNote(m.id, note)} />
            </td>
            <td className="py-3 text-right">
              <span
                className={`tabular-nums ${m.recentCancellations >= FREQUENT_CANCELLATIONS ? "text-danger font-medium" : m.recentCancellations === 0 ? "text-muted" : "text-body"}`}
              >
                {m.recentCancellations}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <PageLayout variant="top" loading={!members && !loadError} action={<AdminMenu />}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">Клієнти</h1>

      {loadError && <p className="text-danger text-sm">Не вдалося завантажити клієнтів.</p>}

      {members && (
        <div className="flex flex-col space-y-8">
          {reloadError && <p className="text-danger text-sm">Не вдалося оновити список. Оновіть сторінку.</p>}
          <StrayPayments />
          <CashRequests requests={cash} onDecided={reloadPurchases} />
          <FreezeRequests requests={freezes} onDecided={reloadPurchases} />
          <CancelRefunds refunds={refunds} onDone={reloadPurchases} />

          {unassigned.length > 0 && (
            <section>
              <h2 className="font-geologica font-semibold text-heading uppercase mb-1">Без тренера</h2>
              <p className="text-muted text-xs mb-3">Нові клієнти. Їх бачать усі тренери, поки хтось не забере собі</p>
              {renderTable(unassigned)}
            </section>
          )}

          <section>
            <h2 className="font-geologica font-semibold text-heading uppercase mb-3">Мої клієнти</h2>
            {mine.length === 0 ? <p className="text-muted text-sm">Клієнтів ще немає.</p> : renderTable(mine)}
          </section>
        </div>
      )}
    </PageLayout>
  );
}
