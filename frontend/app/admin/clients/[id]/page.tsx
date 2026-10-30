"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, AdminMember, MemberFreeze, MemberVisit, Trainer, statusOf } from "@/lib/api";
import { PageLayout } from "@/components/ui/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { MemberPurchases } from "./MemberPurchases";
import { CancellationHistory, NoteCell, PurchaseSummary, TrainerPicker } from "@/components/admin/ClientParts";
import { ddmm, shortDay } from "@/lib/dates";
import { TYPE_LABEL } from "@/lib/trainingTypes";
import { toAdminLogin } from "@/lib/adminAuth";

const MARK: Record<MemberVisit["attendance"], { text: string; className: string }> = {
  PRESENT: { text: "✓ Відвідано", className: "text-accent" },
  ABSENT: { text: "✗ Пропущено", className: "text-danger" },
  UNMARKED: { text: "— Не відмічено", className: "text-subtle" },
};

const sectionTitle = "text-subtle text-xs font-semibold uppercase tracking-wide mb-2";

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
            {shortDay(v.localDate)}, {v.slotTime}
            <span className="block text-subtle text-xs">{TYPE_LABEL[v.trainingType]}</span>
          </span>
          <span className={`text-xs whitespace-nowrap ${MARK[v.attendance].className}`}>{MARK[v.attendance].text}</span>
        </div>
      ))}
    </div>
  );
}

const FREEZE_STATUS: Record<MemberFreeze["status"], string> = {
  REQUESTED: "чекає підтвердження",
  ACTIVE: "триває",
  ENDED: "закінчилась",
  REJECTED: "відхилено",
  CANCELLED: "клієнт скасував запит",
};

// The client's freezes: dates, state, who approved. Hidden when there were none
function Freezes({ memberId, headingClass }: { memberId: string; headingClass: string }) {
  const [items, setItems] = useState<MemberFreeze[] | null>(null);

  useEffect(() => {
    api
      .getMemberFreezes(memberId)
      .then(setItems)
      .catch(() => setItems([]));
  }, [memberId]);

  if (!items?.length) return null;
  return (
    <section>
      <h2 className={headingClass}>Заморозки</h2>
      <div className="flex flex-col">
        {items.map((f) => (
          <div key={f.id} className="flex justify-between space-x-3 py-1.5 border-b border-line last:border-0">
            <span className="text-heading">
              {f.startedOn && f.until
                ? f.until < f.startedOn
                  ? `${ddmm(f.startedOn)}, розморожено того ж дня`
                  : `${ddmm(f.startedOn)} – ${ddmm(f.until)}`
                : `Запит ${shortDay(f.requestedAt.slice(0, 10))}`}
              {f.decidedBy && <span className="block text-subtle text-xs">{f.decidedBy}</span>}
            </span>
            <span className="text-xs whitespace-nowrap text-subtle">
              {f.status === "ACTIVE" && f.unfreezeRequested ? "просить розморозити" : FREEZE_STATUS[f.status]}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// Everything about one client: card and trainings, visits, cancellations, purchases
export default function ClientPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [member, setMember] = useState<AdminMember | null>(null);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [myId, setMyId] = useState("");
  // The trainer list for «Тренер» didn't load: the picker would be empty with no reason given
  const [trainersFailed, setTrainersFailed] = useState(false);
  const [loadError, setLoadError] = useState<"missing" | "failed" | null>(null);

  const load = useCallback(
    () =>
      api
        .getMember(id)
        .then(setMember)
        .catch((err: unknown) => {
          if (!toAdminLogin(err, router)) setLoadError(statusOf(err) === 404 ? "missing" : "failed");
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
      .catch((err: unknown) => {
        if (!toAdminLogin(err, router)) setTrainersFailed(true);
      });
  }, [load, router]);

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
            <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase">
              {member.displayName}
            </h1>
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
            {trainersFailed && (
              <p className="text-danger text-xs mt-1">Не вдалося завантажити тренерів. Оновіть сторінку.</p>
            )}
          </div>

          <section>
            <h2 className={sectionTitle}>Примітка</h2>
            <NoteCell member={member} onSaved={(trainerNote) => setMember({ ...member, trainerNote })} />
          </section>

          <section className="bg-surface border border-line rounded-xl p-4">
            <MemberPurchases memberId={member.id} onChanged={load} />
          </section>

          <Freezes memberId={member.id} headingClass={sectionTitle} />

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
