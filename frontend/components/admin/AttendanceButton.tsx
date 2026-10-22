import type { AttendanceStatus } from "@/lib/api";

const LABELS: Record<AttendanceStatus, string> = {
  PRESENT: "✓",
  ABSENT: "✗",
  UNMARKED: "—",
};

const COLORS: Record<AttendanceStatus, string> = {
  PRESENT: "bg-teal/10 text-teal border-teal",
  ABSENT: "bg-danger/10 text-danger border-danger",
  UNMARKED: "bg-surface text-body border-muted",
};

const TITLES: Record<AttendanceStatus, string> = {
  PRESENT: "присутність",
  ABSENT: "відсутність",
  UNMARKED: "без відмітки",
};

// — → ✓ → ✗ → —
export function nextAttendance(current: AttendanceStatus): AttendanceStatus {
  if (current === "UNMARKED") return "PRESENT";
  if (current === "PRESENT") return "ABSENT";
  return "UNMARKED";
}

// Round attendance toggle used on the today page and in history; always editable
export function AttendanceButton({
  status,
  name,
  disabled,
  onChange,
}: {
  status: AttendanceStatus;
  name: string;
  disabled?: boolean;
  onChange: (next: AttendanceStatus) => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={() => onChange(nextAttendance(status))}
      aria-label={`${name}: ${TITLES[status]}. Натисніть, щоб змінити`}
      title={TITLES[status]}
      className={`w-8 h-8 rounded-full border text-xs font-bold shrink-0 transition-colors disabled:opacity-50 ${COLORS[status]}`}
    >
      {LABELS[status]}
    </button>
  );
}
