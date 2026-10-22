"use client";
import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, AdminMember, MemberCancellation } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { CancellationList } from "@/components/admin/CancellationList";

const NOTE_MAX = 300;
// Highlight clients who cancel often (count over the last 30 days)
const FREQUENT_CANCELLATIONS = 3;

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

export default function ClientsPage() {
  const router = useRouter();
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  useEffect(() => {
    api.getMembers()
      .then(setMembers)
      .catch((err: unknown) => {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) router.push("/admin/login");
        else setLoadError(true);
      });
  }, [router]);

  const updateNote = (id: string, trainerNote: string | null) =>
    setMembers((prev) => prev?.map((m) => (m.id === id ? { ...m, trainerNote } : m)) ?? null);

  return (
    <PageLayout
      variant="top"
      loading={!members && !loadError}
      action={
        <Link href="/admin" className="text-muted text-sm hover:text-body transition-colors">
          ← Назад
        </Link>
      }
    >
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">
        Клієнти
      </h1>

      {loadError && <p className="text-danger text-sm">Не вдалося завантажити клієнтів.</p>}

      {members && members.length === 0 && <p className="text-muted text-sm">Клієнтів ще немає.</p>}

      {members && members.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted text-xs text-left border-b border-line">
              <th className="py-2 pr-3 font-medium w-2/5">Клієнт</th>
              <th className="py-2 pr-3 font-medium">Нотатка</th>
              <th className="py-2 font-medium text-right" title="Скасування за останні 30 днів">Скасувань</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <Fragment key={m.id}>
                <tr className={`align-top ${openHistory === m.id ? "" : "border-b border-line"}`}>
                  <td className="py-3 pr-3">
                    <div className="text-heading">{m.displayName}</div>
                    <div className="text-muted text-xs">{m.memberCode}</div>
                  </td>
                  <td className="py-3 pr-3">
                    <NoteCell member={m} onSaved={(note) => updateNote(m.id, note)} />
                  </td>
                  <td className="py-3 text-right">
                    <button
                      onClick={() => setOpenHistory(openHistory === m.id ? null : m.id)}
                      aria-expanded={openHistory === m.id}
                      title="Показати історію скасувань"
                      className={`tabular-nums hover:text-heading transition-colors ${m.recentCancellations >= FREQUENT_CANCELLATIONS ? "text-danger font-medium" : "text-body"}`}
                    >
                      {m.recentCancellations} {openHistory === m.id ? "▴" : "▾"}
                    </button>
                  </td>
                </tr>
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
      )}
    </PageLayout>
  );
}
