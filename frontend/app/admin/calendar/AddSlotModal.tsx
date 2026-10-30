"use client";
import { useState } from "react";
import { api, AdminMember, TrainerSchedule, TrainingType } from "@/lib/api";
import { TYPE_COLORS, TYPE_LABEL_PLURAL } from "@/lib/trainingTypes";
import { errorText } from "@/lib/apiErrors";
import { longDay } from "@/lib/dates";
import { Modal } from "@/components/ui/Modal";
import { MemberPickers } from "./MemberPickers";
import { FIELD_CLASS, TIME_RE, TYPES, fieldsFor, useSave, weekdayOf } from "./slotForm";

// «Додати тренування» on a clicked day: групові (a time, this day only or weekly) or персональні / спліт (a time and
// members). Another training that day: click the day again
export function AddSlotModal({
  date,
  initialTime,
  schedule,
  onScheduleSaved,
  members,
  onDone,
  onClose,
}: {
  date: string;
  initialTime: string;
  schedule: TrainerSchedule | null;
  onScheduleSaved: (schedule: TrainerSchedule) => void;
  members: AdminMember[];
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [selectedType, setSelectedType] = useState<TrainingType>("group");
  const [time, setTime] = useState(initialTime);
  // Group trainings only: «Лише цього дня» or «Щотижня» (adds the time to the schedule)
  const [weekly, setWeekly] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const { saving, setSaving, error, setError, run } = useSave(onDone);

  // A group training before the trainer's booking opens can't be booked: warned under the time
  const opensAt = schedule?.bookingOpensAt ?? "";
  const assigned = selectedType !== "group";

  const selectType = (type: TrainingType) => {
    setSelectedType(type);
    setMemberIds((ids) => fieldsFor(type, ids));
  };

  const handleAdd = () => {
    if (!TIME_RE.test(time)) return setError("Вкажіть час з кроком 15 хвилин, наприклад 18:30");
    if (selectedType === "group") {
      if (!weekly) return run(() => api.upsertGroupSlot(date, time), "Помилка збереження. Спробуйте ще раз.");
      return addWeekly();
    }
    if (!memberIds[0]) return setError("Виберіть людину");
    return run(
      () =>
        api.createAssignedSlot(date, {
          slotTime: time,
          trainingType: selectedType,
          memberIds: memberIds.filter(Boolean),
        }),
      "Помилка збереження. Спробуйте ще раз.",
    );
  };

  // «Щотижня»: the time goes into «Розклад групових» first (its rules checked there, nothing saved on an error),
  // which adds the trainings 3 weeks ahead; then this date itself, which can be further ahead or a cancelled day
  const addWeekly = async () => {
    if (!schedule) return setError("Розклад не завантажився. Оновіть сторінку.");
    const weekday = weekdayOf(date);
    const has = schedule.times.some((t) => t.weekday === weekday && t.slotTime === time);
    const next: TrainerSchedule = {
      ...schedule,
      autoCreate: true,
      times: has ? schedule.times : [...schedule.times, { weekday, slotTime: time }],
    };
    setSaving(true);
    setError("");
    try {
      const { bookingOpensAt, autoCreate, times } = await api.saveMySchedule(next);
      onScheduleSaved({ bookingOpensAt, autoCreate, times });
    } catch (err: unknown) {
      setSaving(false);
      return setError(errorText(err, "Помилка збереження. Спробуйте ще раз."));
    }
    setSaving(false);
    return run(
      () => api.upsertGroupSlot(date, time),
      "Щотижня збережено, але на цю дату не додалось. Спробуйте ще раз.",
    );
  };

  return (
    <Modal variant="card" onDismiss={onClose} labelledBy="calendar-modal-title">
      <div>
        <p className="text-muted text-xs uppercase tracking-wide mb-1">{longDay(date)}</p>
        <p id="calendar-modal-title" className="font-geologica font-semibold text-heading">
          Додати тренування
        </p>
      </div>

      <div className="flex flex-col space-y-2">
        {TYPES.map((t) => (
          <button
            type="button"
            key={t}
            onClick={() => selectType(t)}
            aria-pressed={selectedType === t}
            className={`flex items-center justify-between px-4 py-3 rounded-xl border text-sm transition-colors ${selectedType === t ? "" : "border-line"}`}
            style={
              selectedType === t
                ? {
                    borderColor: TYPE_COLORS[t].border,
                    backgroundColor: TYPE_COLORS[t].bg,
                    color: TYPE_COLORS[t].text,
                  }
                : {}
            }
          >
            <span>{TYPE_LABEL_PLURAL[t]}</span>
            {selectedType === t && <span>✓</span>}
          </button>
        ))}
      </div>

      <div>
        <label htmlFor="slot-time" className="block text-muted text-xs mb-2 uppercase tracking-wide">
          Час
        </label>
        <input
          id="slot-time"
          type="time"
          step={900}
          value={time}
          onChange={(e) => setTime(e.target.value)}
          // iOS Safari gives a time input its own min width and ignores w-full without these
          className={`${FIELD_CLASS} block min-w-0 appearance-none [color-scheme:dark] [&::-webkit-date-and-time-value]:text-left`}
        />
        {!assigned && opensAt && TIME_RE.test(time) && time <= opensAt && (
          <p className="text-warn text-xs mt-2">
            Запис відкривається о {opensAt}, тож на це тренування записатися не вийде
          </p>
        )}
      </div>

      {!assigned && (
        <div className="space-y-2">
          <div className="flex space-x-2">
            {[
              { value: false, label: "Лише цього дня" },
              { value: true, label: "Щотижня" },
            ].map((o) => (
              <button
                type="button"
                key={o.label}
                onClick={() => setWeekly(o.value)}
                aria-pressed={weekly === o.value}
                className={`flex-1 px-2 py-2 rounded-lg border text-xs whitespace-nowrap transition-colors ${weekly === o.value ? "border-accent text-accent" : "border-line text-muted"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          {weekly && (
            <p className="text-muted text-xs">
              Додасться в «Розклад групових»: щотижня в цей день
              {schedule && !schedule.autoCreate
                ? ". У розкладі увімкнеться «Автоматично додавати на 3 тижні наперед»"
                : ""}
            </p>
          )}
        </div>
      )}

      {assigned && (
        <MemberPickers type={selectedType} memberIds={memberIds} setMemberIds={setMemberIds} members={members} />
      )}

      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}

      <div className="flex flex-col space-y-2">
        <button
          type="button"
          onClick={handleAdd}
          disabled={saving}
          className="btn-primary w-full py-3 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
        >
          {saving ? "Зачекайте..." : "Зберегти"}
        </button>
        <button type="button" onClick={onClose} className="text-muted text-sm py-2 transition-colors hover:text-body">
          Закрити
        </button>
      </div>
    </Modal>
  );
}
