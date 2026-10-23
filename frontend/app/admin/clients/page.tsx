"use client";
import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, AdminMember, Trainer, MemberCancellation, CashRequest } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { CancellationList } from "@/components/admin/CancellationList";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { CashRequests } from "@/components/admin/CashRequests";
import { MemberPurchases } from "@/components/admin/MemberPurchases";

const NOTE_MAX = 300;
// Highlight clients who cancel often (count over the last 30 days)
const FREQUENT_CANCELLATIONS = 3;

const TYPE_SHORT: Record<AdminMember["packagesLeft"][number]["trainingType"], string> = {
  групові: "Груп.",
  персональні: "Перс.",
  спліт: "Спліт",
};

const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

// «карта до 15.12 · Перс. 5 · Спліт 2» under the client's name
function purchaseSummary(m: AdminMember) {
  const card = !m.clubCard
    ? "без карти"
    : m.clubCard.state === "active"
      ? `карта до ${ddmm(m.clubCard.until)}`
      : "клубна карта чекає активації";
  return [card, ...m.packagesLeft.map((p) => `${TYPE_SHORT[p.trainingType]} ${p.left}`)].join(" · ");
}

function trainingLabel(c: MemberCancellation) {
  const day = new Date(c.localDate + "T12:00:00").toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
  return `${day}, ${c.slotTime}`;
}

// Latest cancellations and moves of one client, loaded when the row is expanded
function CancellationHistory({ memberId }: { memberId: string }) {
  const [items, setItems] = useState<MemberCancellation[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.getMemberCancellations(memberId).then(setItems).catch(() => setFailed(true));
  }, [memberId]);

  if (failed) return <p className="text-danger text-xs">Не вдалося завантажити історію</p>;
  if (!items) return <p className="text-muted text-xs">Завантаження...</p>;
  if (items.length === 0) return <p className="text-muted text-xs">Скасувань і перенесень не було</p>;
  return (
    <CancellationList
      title="Історія скасувань"
      items={items.map((c) => ({ ...c, label: trainingLabel(c) }))}
      withDate
    />
  );
}

function NoteCell({ member, onSaved }: { member: AdminMember; onSaved: (note: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(member.trainerNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (draft.trim() === (member.trainerNote ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { trainerNote } = await api.updateMemberNote(member.id, draft);
      onSaved(trainerNote);
      setEditing(false);
    } catch {
      setError("Не вдалося зберегти");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        onClick={() => { setDraft(member.trainerNote ?? ""); setEditing(true); }}
        className="w-full text-left text-sm hover:text-heading transition-colors"
      >
        {member.trainerNote ? (
          <span className="text-body whitespace-pre-wrap break-words">{member.trainerNote}</span>
        ) : (
          <span className="text-muted">+ нотатка</span>
        )}
      </button>
    );
  }

  return (
    <div className="flex flex-col space-y-1">
      <textarea
        autoFocus
        value={draft}
        maxLength={NOTE_MAX}
        rows={2}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
          if (e.key === "Escape") setEditing(false);
        }}
        className="input-field w-full border rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
        placeholder="Напр.: ходить через раз"
      />
      {error && <span className="text-danger text-xs">{error}</span>}
    </div>
  );
}

// Under the client's name: hand the client to another trainer, or claim an unassigned one
function TrainerPicker({
  member,
  trainers,
  myId,
  onAssigned,
}: {
  member: AdminMember;
  trainers: Trainer[];
  myId: string;
  onAssigned: (trainerId: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const assign = async (trainerId: string) => {
    if (!trainerId || trainerId === member.trainerId) return;
    setSaving(true);
    setError("");
    try {
      await api.assignTrainer(member.id, trainerId);
      onAssigned(trainerId);
    } catch {
      setError("Не вдалося змінити тренера");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col items-start space-y-1 mt-2">
      {!member.trainerId && (
        <button
          onClick={() => assign(myId)}
          disabled={saving}
          className="btn-secondary text-xs px-3 py-1 rounded-md border transition-colors disabled:opacity-60"
        >
          Забрати собі
        </button>
      )}
      <label className="flex items-center space-x-1 text-xs text-muted">
        <span>Тренер:</span>
        <select
          aria-label={`Тренер для ${member.displayName}`}
          value={member.trainerId ?? ""}
          disabled={saving}
          onChange={(e) => assign(e.target.value)}
          className="bg-transparent text-body border-b border-line focus:outline-none focus:border-accent"
        >
          {!member.trainerId && <option value="">не вибрано</option>}
          {trainers.map((c) => (
            <option key={c.id} value={c.id}>{c.id === myId ? `${c.username} (я)` : c.username}</option>
          ))}
        </select>
      </label>
      {error && <span className="text-danger text-xs">{error}</span>}
    </div>
  );
}

export default function ClientsPage() {
  const router = useRouter();
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [myId, setMyId] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [openPurchases, setOpenPurchases] = useState<string | null>(null);
  const [cash, setCash] = useState<CashRequest[]>([]);

  // After a cash decision or a manual card: the request list and the summaries change
  const reloadPurchases = () => {
    api.getPendingCash().then(setCash).catch(() => {});
    api.getMembers().then(setMembers).catch(() => {});
  };

  useEffect(() => {
    Promise.all([api.getMembers(), api.getTrainers(), api.me(), api.getPendingCash()])
      .then(([memberList, trainerList, me, cashList]) => {
        setMembers(memberList);
        setTrainers(trainerList);
        setMyId(me.id);
        setCash(cashList);
      })
      .catch((err: unknown) => {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) router.push("/admin/login");
        else setLoadError(true);
      });
  }, [router]);

  const updateNote = (id: string, trainerNote: string | null) =>
    setMembers((prev) => prev?.map((m) => (m.id === id ? { ...m, trainerNote } : m)) ?? null);

  // Given to another trainer: the client leaves this trainer's list
  const updateTrainer = (id: string, trainerId: string) =>
    setMembers((prev) =>
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
          <th className="py-2 pr-3 font-medium">Нотатка</th>
          <th className="py-2 font-medium text-right" title="Скасування за останні 30 днів">Скасувань</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <Fragment key={m.id}>
            <tr className={`align-top ${openHistory === m.id || openPurchases === m.id ? "" : "border-b border-line"}`}>
              <td className="py-3 pr-3">
                <div className="text-heading">{m.displayName}</div>
                <div className="text-muted text-xs">{m.memberCode}</div>
                <button
                  onClick={() => setOpenPurchases(openPurchases === m.id ? null : m.id)}
                  aria-expanded={openPurchases === m.id}
                  className="text-xs text-body hover:text-heading transition-colors mt-1 text-left"
                >
                  {purchaseSummary(m)} {openPurchases === m.id ? "▴" : "▾"}
                </button>
                <TrainerPicker member={m} trainers={trainers} myId={myId} onAssigned={(trainerId) => updateTrainer(m.id, trainerId)} />
              </td>
              <td className="py-3 pr-3">
                <NoteCell member={m} onSaved={(note) => updateNote(m.id, note)} />
              </td>
              <td className="py-3 text-right">
                {m.recentCancellations === 0 ? (
                  <span className="tabular-nums text-muted">0</span>
                ) : (
                <button
                  onClick={() => setOpenHistory(openHistory === m.id ? null : m.id)}
                  aria-expanded={openHistory === m.id}
                  title="Показати історію скасувань"
                  className={`tabular-nums hover:text-heading transition-colors ${m.recentCancellations >= FREQUENT_CANCELLATIONS ? "text-danger font-medium" : "text-body"}`}
                >
                  {m.recentCancellations} {openHistory === m.id ? "▴" : "▾"}
                </button>
                )}
              </td>
            </tr>
            {openPurchases === m.id && (
              <tr className="border-b border-line">
                <td colSpan={3} className="pb-4">
                  <div className="bg-surface border border-line rounded-xl p-3">
                    <MemberPurchases memberId={m.id} onChanged={reloadPurchases} />
                  </div>
                </td>
              </tr>
            )}
            {openHistory === m.id && (
              <tr className="border-b border-line">
                <td colSpan={3} className="pb-4">
                  <div className="bg-surface border border-line rounded-xl p-3">
                    <CancellationHistory memberId={m.id} />
                  </div>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );

  return (
    <PageLayout
      variant="top"
      loading={!members && !loadError}
      action={<AdminMenu />}
    >
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">
        Клієнти
      </h1>

      {loadError && <p className="text-danger text-sm">Не вдалося завантажити клієнтів.</p>}

      {members && (
        <div className="flex flex-col space-y-8">
          <CashRequests requests={cash} onDecided={reloadPurchases} />

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
