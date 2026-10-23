"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, AdminMember, MemberVisit, Trainer } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { MemberPurchases } from "@/components/admin/MemberPurchases";
import { CancellationHistory, NoteCell, PurchaseSummary, TrainerPicker } from "@/components/admin/ClientParts";

const TYPE_LABEL: Record<MemberVisit["trainingType"], string> = {
  групові: "Групове",
  персональні: "Персональне",
  спліт: "Спліт",
};

const MARK: Record<MemberVisit["attendance"], { text: string; className: string }> = {
  PRESENT: { text: "✓ Відвідано", className: "text-accent" },
  ABSENT: { text: "✗ Пропущено", className: "text-danger" },
  UNMARKED: { text: "— Не відмічено", className: "text-subtle" },
};

const sectionTitle = "text-subtle text-xs font-semibold uppercase tracking-wide mb-2";

function visitDay(localDate: string) {
  return new Date(localDate + "T12:00:00").toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
}

// The trainings the client was booked on, up to today, with the mark
function Visits({ memberId }: { memberId: string }) {
  const [items, setItems] = useState<MemberVisit[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .getMemberVisits(memberId)
      .then(setItems)
      .catch(() => setFailed(true));
  }, [memberId]);

  if (failed) return <p className="text-danger text-xs">Не вдалося завантажити відвідування</p>;
  if (!items) return <p className="text-muted text-xs">Завантаження...</p>;
  if (items.length === 0) return <p className="text-subtle">Ще не було тренувань</p>;
  return (
    <div className="flex flex-col">
      {items.map((v) => (
        <div key={v.bookingId} className="flex justify-between space-x-3 py-1.5 border-b border-line last:border-0">
          <span className="text-heading">
            {visitDay(v.localDate)}, {v.slotTime}
            <span className="block text-subtle text-xs">{TYPE_LABEL[v.trainingType]}</span>
          </span>
          <span className={`text-xs whitespace-nowrap ${MARK[v.attendance].className}`}>{MARK[v.attendance].text}</span>
        </div>
      ))}
    </div>
  );
}

// Everything about one client: card and trainings, visits, cancellations, purchases
export default function ClientPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [member, setMember] = useState<AdminMember | null>(null);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [myId, setMyId] = useState("");
  const [loadError, setLoadError] = useState<"missing" | "failed" | null>(null);

  const load = useCallback(
    () =>
      api
        .getMember(id)
        .then(setMember)
        .catch((err: unknown) => {
          const status = (err as { status?: number }).status;
          if (status === 401 || status === 403) router.push("/admin/login");
          else setLoadError(status === 404 ? "missing" : "failed");
        }),
    [id, router],
  );

  useEffect(() => {
    load();
    Promise.all([api.getTrainers(), api.me()])
      .then(([trainerList, me]) => {
        setTrainers(trainerList);
        setMyId(me.id);
      })
      .catch(() => {});
  }, [load]);

  const back = (
    <Link href="/admin/clients" className="text-muted text-sm hover:text-body transition-colors">
      ← Клієнти
    </Link>
  );

  return (
    <PageLayout variant="top" loading={!member && !loadError} action={<AdminMenu />}>
      {back}
      {loadError && (
        <p className="text-danger text-sm mt-4">
          {loadError === "missing" ? "Клієнта не знайдено." : "Не вдалося завантажити клієнта."}
        </p>
      )}

      {member && (
        <div className="flex flex-col space-y-6 mt-4">
          <div>
            <h1 className="font-geologica font-semibold text-title text-heading uppercase">{member.displayName}</h1>
            <p className="text-muted text-xs mt-1">{member.memberCode}</p>
            <PurchaseSummary m={member} className="mt-2" />
            <TrainerPicker
              member={member}
              trainers={trainers}
              myId={myId}
              onAssigned={(trainerId) =>
                // Given to another trainer: this client is no longer theirs to see
                trainerId === myId ? setMember({ ...member, trainerId }) : router.push("/admin/clients")
              }
            />
          </div>

          <section>
            <h2 className={sectionTitle}>Примітка</h2>
            <NoteCell member={member} onSaved={(trainerNote) => setMember({ ...member, trainerNote })} />
          </section>

          <section className="bg-surface border border-line rounded-xl p-4">
            <MemberPurchases memberId={member.id} onChanged={load} />
          </section>

          <section>
            <h2 className={sectionTitle}>Відвідування</h2>
            <Visits memberId={member.id} />
          </section>

          <CancellationHistory
            memberId={member.id}
            recentCancellations={member.recentCancellations}
            headingClass={sectionTitle}
          />
        </div>
      )}
    </PageLayout>
  );
}
