import { TrainingPackage } from "@/lib/api";
import { ddmm } from "@/lib/dates";

// A trainer service's title already names its type
export const packageTitle = (p: TrainingPackage) => (p.trainingType === "group" ? `Групові · ${p.title}` : p.title);

// One circle per training; wraps onto a second row for 10-12
function TrainingDots({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex flex-wrap -m-1 mt-3" role="img" aria-label={`Пройдено ${done} з ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`m-1 w-7 h-7 rounded-full flex items-center justify-center ${
            i < done ? "bg-teal" : i === done ? "border-2 border-teal" : "border-2 border-muted/50"
          }`}
        >
          {i < done && (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-on-teal"
              aria-hidden
            >
              <path d="M5 12l5 5 9-10" />
            </svg>
          )}
        </span>
      ))}
    </div>
  );
}

export function PackageCard({ p }: { p: TrainingPackage }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between space-x-3">
        <span className="text-heading font-semibold">{packageTitle(p)}</span>
        <span className="text-subtle text-xs whitespace-nowrap">
          {p.state === "active" ? `діє до ${ddmm(p.validUntil)}` : `почати до ${ddmm(p.activateBy)}`}
        </span>
      </div>
      <TrainingDots done={p.total - p.left} total={p.total} />
      <p className="text-body text-xs mt-3">
        {p.total - p.left > 0 ? (
          <>
            Пройдено <span className="text-accent font-semibold">{p.total - p.left}</span> з {p.total} · ще {p.left}{" "}
            попереду
          </>
        ) : (
          `Почнеться з першого тренування · ${p.total} попереду`
        )}
      </p>
    </div>
  );
}
