import type { TrainingType } from "@/lib/api";
import { FIELD_CLASS } from "./slotForm";

type PickerMember = { id: string; displayName: string; memberCode?: string };

// Who a personal / split training is for: one select per place, a member chosen once
export function MemberPickers({
  type,
  memberIds,
  setMemberIds,
  members,
}: {
  type: TrainingType;
  memberIds: string[];
  setMemberIds: (update: (ids: string[]) => string[]) => void;
  members: PickerMember[];
}) {
  return (
    <div className="flex flex-col space-y-2">
      <p className="text-muted text-xs uppercase tracking-wide">{type === "split" ? "Люди (до трьох)" : "Людина"}</p>
      {memberIds.map((id, i) => (
        <select
          key={i}
          aria-label={`Людина ${i + 1}`}
          value={id}
          onChange={(e) => setMemberIds((ids) => ids.map((v, j) => (j === i ? e.target.value : v)))}
          className={FIELD_CLASS}
        >
          <option value="">{i === 0 ? "Виберіть людину" : "Не вибрано (необовʼязково)"}</option>
          {members
            .filter((m) => m.id === id || !memberIds.includes(m.id))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.memberCode ? `${m.displayName} · ${m.memberCode}` : m.displayName}
              </option>
            ))}
        </select>
      ))}
      <p className="text-muted text-xs">Тренування побачать тільки вибрані люди</p>
    </div>
  );
}
