import { useState } from "react";
import type { TrainingType } from "@/lib/api";
import { errorText } from "@/lib/apiErrors";

export const TYPES: TrainingType[] = ["групові", "персональні", "спліт"];
// Member pickers per type: персональні exactly 1, спліт 1 required + 2 optional
const MEMBER_FIELDS: Record<TrainingType, number> = { групові: 0, персональні: 1, спліт: 3 };
export const TIME_RE = /^([01]\d|2[0-3]):(00|15|30|45)$/;
export const FIELD_CLASS = "input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none";

// The backend's weekday of a date: 1 = Пн … 7 = Нд
export function weekdayOf(date: string) {
  return new Date(date + "T12:00:00").getDay() || 7;
}

// One entry per member picker of that type; "" = not chosen
export function fieldsFor(type: TrainingType, ids: string[] = []) {
  return Array.from({ length: MEMBER_FIELDS[type] }, (_, i) => ids[i] ?? "");
}

// A modal's save: one request at a time, the error worded for a person; `onDone` reloads the calendar and closes
export function useSave(onDone: () => Promise<void>) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setSaving(true);
    setError("");
    try {
      await fn();
      await onDone();
    } catch (err: unknown) {
      setError(errorText(err, fallback));
    } finally {
      setSaving(false);
    }
  };
  return { saving, setSaving, error, setError, run };
}
