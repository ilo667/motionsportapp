"use client";
import Link from "next/link";
import { api, AdminMember } from "@/lib/api";
import { PageLayout } from "@/components/ui/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { CashRequests } from "./CashRequests";
import { StrayPayments } from "./StrayPayments";
import { FreezeRequests } from "./FreezeRequests";
import { CancelRefunds } from "./CancelRefunds";
import { FREQUENT_CANCELLATIONS, NoteCell, PurchaseSummary, TrainerPicker } from "@/components/admin/ClientParts";
import { useAdminData } from "@/lib/useAdminData";

// The list, the trainers to reassign to, who is signed in, and the requests on top
const loadClientsPage = () =>
  Promise.all([
    api.getMembers(),
    api.getTrainers(),
    api.me(),
    api.getPendingCash(),
    api.getPendingFreezes(),
    api.getPendingCancelRefunds(),
  ]).then(([members, trainers, me, cash, freezes, refunds]) => ({
    members,
    trainers,
    myId: me.id,
    cash,
    freezes,
    refunds,
  }));

export default function ClientsPage() {
  // After a cash, freeze or refund decision `reload` refreshes the requests and the summaries; if that fails the
  // page keeps the old lists and says they are stale
  const { data, setData, error, reload } = useAdminData(loadClientsPage);
  const loadError = error != null && !data;
  const reloadError = error != null && !!data;
  const members = data?.members ?? null;
  const trainers = data?.trainers ?? [];
  const myId = data?.myId ?? "";

  const setMembers = (update: (members: AdminMember[]) => AdminMember[]) =>
    setData((prev) => prev && { ...prev, members: update(prev.members) });

  const updateNote = (id: string, trainerNote: string | null) =>
    setMembers((list) => list.map((m) => (m.id === id ? { ...m, trainerNote } : m)));

  // Given to another trainer: the client leaves this trainer's list
  const updateTrainer = (id: string, trainerId: string) =>
    setMembers((list) =>
      trainerId === myId ? list.map((m) => (m.id === id ? { ...m, trainerId } : m)) : list.filter((m) => m.id !== id),
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

      {loadError && (
        <p role="alert" className="text-danger text-sm">
          Не вдалося завантажити клієнтів.
        </p>
      )}

      {members && (
        <div className="flex flex-col space-y-8">
          {reloadError && (
            <p role="alert" className="text-danger text-sm">
              Не вдалося оновити список. Оновіть сторінку.
            </p>
          )}
          <StrayPayments />
          <CashRequests requests={data?.cash ?? []} onDecided={reload} />
          <FreezeRequests requests={data?.freezes ?? []} onDecided={reload} />
          <CancelRefunds refunds={data?.refunds ?? []} onDone={reload} />

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
