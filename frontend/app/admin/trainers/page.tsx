"use client";
import { useState } from "react";
import { api, Trainer } from "@/lib/api";
import { PageLayout } from "@/components/ui/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";
import { useAdminData } from "@/lib/useAdminData";
import { DisableDialog } from "./DisableDialog";
import { InviteSection } from "./InviteSection";
import { PasswordSection } from "./PasswordSection";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("uk-UA", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Kyiv",
  });
}

const loadTrainersPage = () =>
  Promise.all([api.getTrainers(), api.getTrainerInvites(), api.me()]).then(([trainers, invites, user]) => ({
    trainers,
    invites,
    me: user.type === "admin" ? (user.username ?? null) : null,
  }));

export default function TrainersPage() {
  const { data, error, reload: load } = useAdminData(loadTrainersPage);
  const trainers = data?.trainers ?? null;
  const invites = data?.invites ?? [];
  const me = data?.me ?? null;
  const loadError = error != null;
  const [disabling, setDisabling] = useState<Trainer | null>(null);
  const [disabledText, setDisabledText] = useState("");

  return (
    <PageLayout variant="top" loading={!trainers && !loadError} action={<AdminMenu />}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">Тренери</h1>

      {loadError && (
        <p role="alert" className="text-danger text-sm">
          Не вдалося завантажити тренерів.
        </p>
      )}

      {trainers && (
        <div className="flex flex-col space-y-10">
          <InviteSection invites={invites} onChange={load} />

          <section>
            <h2 className="font-geologica font-semibold text-heading uppercase mb-3">Усі тренери</h2>
            {disabledText && <p className="text-accent text-sm mb-3">{disabledText}</p>}
            <ul className="border-t border-line">
              {trainers.map((t) => (
                <li key={t.id} className="flex items-center justify-between space-x-3 py-3 border-b border-line">
                  <div className="min-w-0">
                    <p className={t.disabledAt ? "text-subtle" : "text-heading"}>
                      {t.username}
                      {t.username === me && <span className="text-subtle"> · це ви</span>}
                    </p>
                    <p className="text-subtle text-sm">
                      з {formatDate(t.createdAt)}
                      {t.invitedBy && ` · запросив(ла) ${t.invitedBy}`}
                    </p>
                    {t.disabledAt && (
                      <p className="text-danger text-sm">
                        вимкнено{t.disabledBy && ` · ${t.disabledBy}`} · {formatDate(t.disabledAt)}
                      </p>
                    )}
                  </div>
                  {!t.disabledAt && t.username !== me && t.id !== firstId(trainers) && (
                    <button
                      type="button"
                      onClick={() => {
                        setDisabledText("");
                        setDisabling(t);
                      }}
                      className="shrink-0 text-sm text-muted hover:text-danger transition-colors"
                    >
                      Вимкнути
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <PasswordSection />
        </div>
      )}

      {disabling && trainers && (
        <DisableDialog
          trainer={disabling}
          // Enabled trainers only, me first
          targets={trainers
            .filter((t) => !t.disabledAt && t.id !== disabling.id)
            .sort((a, b) => Number(b.username === me) - Number(a.username === me))}
          onClose={() => setDisabling(null)}
          // Someone disabled them first: reload shows it
          onConflict={load}
          onDone={(text) => {
            setDisabling(null);
            setDisabledText(text);
            load();
          }}
        />
      )}
    </PageLayout>
  );
}

// The first trainer can't be disabled: unassigned clients see their group trainings
function firstId(trainers: Trainer[]) {
  return [...trainers].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.id;
}
