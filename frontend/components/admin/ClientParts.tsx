"use client";
import { useEffect, useState } from "react";
import { api, AdminMember, Trainer, MemberCancellation } from "@/lib/api";
import { CancellationList } from "@/components/admin/CancellationList";
import { plural } from "@/lib/plural";
import { ddmm, shortDay } from "@/lib/dates";

// Pieces of a client shared by the «Клієнти» list and the client page

const NOTE_MAX = 300;
// Highlight clients who cancel often (count over the last 30 days)
export const FREQUENT_CANCELLATIONS = 3;

// Word forms for 1, 2–4 and 5+ trainings («1 персональне», «3 групові», «8 персональних»)
const TYPE_FORMS: Record<AdminMember["packagesLeft"][number]["trainingType"], [string, string, string]> = {
  групові: ["групове", "групові", "групових"],
  персональні: ["персональне", "персональні", "персональних"],
  спліт: ["спліт", "спліт", "спліт"],
};

// Under the client's name, one badge per line: frozen («Заморожено до DD.MM»), the club card («Клубна карта
// чекає активації»), then one per type of trainings left («8 персональних», «9 групових»)
export function PurchaseSummary({ m, className = "" }: { m: AdminMember; className?: string }) {
  const [text, cardClass] = !m.clubCard
    ? ["Без клубної карти", "text-subtle border-line"]
    : m.clubCard.state === "active"
      ? [`Клубна карта до ${ddmm(m.clubCard.until)}`, "text-accent bg-teal/10 border-teal/30"]
      : ["Клубна карта чекає активації", "text-warn bg-warn-bg border-warn-line"];
  const badge = "border rounded-full px-2.5 py-1";
  return (
    <div className={`flex flex-col items-start space-y-1.5 text-xs ${className}`}>
      {m.frozenUntil && (
        <span className={`font-semibold text-warn bg-warn-bg border-warn-line ${badge}`}>
          Заморожено до {ddmm(m.frozenUntil)}
        </span>
      )}
      <span className={`font-semibold ${badge} ${cardClass}`}>{text}</span>
      {m.packagesLeft.map((p) => (
        <span key={p.trainingType} className={`text-body border-line ${badge}`}>
          {plural(p.left, TYPE_FORMS[p.trainingType])}
        </span>
      ))}
    </div>
  );
}

export function trainingLabel(c: MemberCancellation) {
  const day = shortDay(c.localDate);
  // A move reads «23 жовт. · 19:00 → 20:00»
  return c.switchedToTime ? `${day} · ${c.slotTime} → ${c.switchedToTime}` : `${day}, ${c.slotTime}`;
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// Latest cancellations and moves of one client, as two blocks: «Скасування» and «Переноси».
// Cancellations over 30 days come from the server (the same number as the list page); moves are counted here
export function CancellationHistory({
  memberId,
  recentCancellations,
  headingClass,
}: {
  memberId: string;
  recentCancellations: number;
  headingClass: string;
}) {
  const [items, setItems] = useState<MemberCancellation[] | null>(null);
  const [recentMoves, setRecentMoves] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .getMemberCancellations(memberId)
      .then((list) => {
        const monthAgo = Date.now() - MONTH_MS;
        setRecentMoves(
          list.filter((c) => c.switchedToTime && c.cancelledAt && new Date(c.cancelledAt).getTime() >= monthAgo).length,
        );
        setItems(list);
      })
      .catch(() => setFailed(true));
  }, [memberId]);

  const status = failed ? (
    <p className="text-danger text-xs">Не вдалося завантажити історію</p>
  ) : !items ? (
    <p className="text-muted text-xs">Завантаження...</p>
  ) : null;
  const cancelled = (items ?? []).filter((c) => !c.switchedToTime);
  const moved = (items ?? []).filter((c) => c.switchedToTime);

  const block = (title: string, list: MemberCancellation[]) => (
    <section>
      <h2 className={headingClass}>{title}</h2>
      {status ??
        (list.length === 0 ? (
          <p className="text-subtle">Не було</p>
        ) : (
          <CancellationList items={list.map((c) => ({ ...c, label: trainingLabel(c), moveInLabel: true }))} withDate />
        ))}
    </section>
  );

  return (
    <>
      {block(`Скасування · ${recentCancellations} за 30 днів`, cancelled)}
      {block(`Переноси · ${items ? recentMoves : "…"} за 30 днів`, moved)}
    </>
  );
}

export function NoteCell({ member, onSaved }: { member: AdminMember; onSaved: (note: string | null) => void }) {
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
        onClick={() => {
          setDraft(member.trainerNote ?? "");
          setEditing(true);
        }}
        className="w-full text-left text-sm hover:text-heading transition-colors"
      >
        {member.trainerNote ? (
          <span className="text-body whitespace-pre-wrap break-words">{member.trainerNote}</span>
        ) : (
          <span className="text-muted">+ примітка</span>
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
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
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
export function TrainerPicker({
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
          className="btn-secondary text-xs px-3 py-1 rounded-lg border transition-colors disabled:opacity-60"
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
          {/* A disabled trainer can't get clients */}
          {trainers
            .filter((c) => !c.disabledAt)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.id === myId ? `${c.username} (я)` : c.username}
              </option>
            ))}
        </select>
      </label>
      {error && <span className="text-danger text-xs">{error}</span>}
    </div>
  );
}
