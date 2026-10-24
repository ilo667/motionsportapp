"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, Trainer, TrainerInvite } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";

const FIELD = "input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none";
const MIN_PASSWORD = 10;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("uk-UA", { day: "numeric", month: "long", year: "numeric" });
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("uk-UA", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

// «Тренери»: invite a trainer by a one-time link, see who is here, change own password
export default function TrainersPage() {
  const router = useRouter();
  const [trainers, setTrainers] = useState<Trainer[] | null>(null);
  const [invites, setInvites] = useState<TrainerInvite[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.getTrainers(), api.getTrainerInvites(), api.me()])
      .then(([t, i, user]) => {
        setTrainers(t);
        setInvites(i);
        setMe(user.type === "admin" ? (user.username ?? null) : null);
      })
      .catch((err: unknown) => {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) router.push("/admin/login");
        else setLoadError(true);
      });
  }, [router]);

  useEffect(load, [load]);

  return (
    <PageLayout variant="top" loading={!trainers && !loadError} action={<AdminMenu />}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">Тренери</h1>

      {loadError && <p className="text-danger text-sm">Не вдалося завантажити тренерів.</p>}

      {trainers && (
        <div className="flex flex-col space-y-10">
          <InviteSection invites={invites} onChange={load} />

          <section>
            <h2 className="font-geologica font-semibold text-heading uppercase mb-3">Усі тренери</h2>
            <ul className="border-t border-line">
              {trainers.map((t) => (
                <li key={t.id} className="py-3 border-b border-line">
                  <p className="text-heading">
                    {t.username}
                    {t.username === me && <span className="text-subtle"> · це ви</span>}
                  </p>
                  <p className="text-subtle text-sm">
                    з {formatDate(t.createdAt)}
                    {t.invitedBy && ` · запросив(ла) ${t.invitedBy}`}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <PasswordSection />
        </div>
      )}
    </PageLayout>
  );
}

function InviteSection({ invites, onChange }: { invites: TrainerInvite[]; onChange: () => void }) {
  // The link is shown only right after it is made: the server keeps just a hash of it
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const { token } = await api.createTrainerInvite();
      setLink(`${window.location.origin}/admin/join?t=${token}`);
      onChange();
    } catch {
      setError("Не вдалося створити посилання. Спробуйте ще раз.");
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!link) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Motion Gym", text: "Запрошення тренера в Motion Gym", url: link });
      } else {
        await navigator.clipboard.writeText(link);
        setCopied(true);
      }
    } catch {
      // The share sheet was closed; nothing to do
    }
  };

  const revoke = async (id: string) => {
    setError("");
    try {
      await api.revokeTrainerInvite(id);
    } catch {
      setError("Запрошення вже використали або відкликали.");
    }
    onChange();
  };

  return (
    <section>
      <h2 className="font-geologica font-semibold text-heading uppercase mb-2">Запросити тренера</h2>
      <p className="text-subtle text-sm mb-4">
        Надішліть посилання новому тренеру: за ним він сам задасть логін і пароль. Посилання діє 7 днів і спрацьовує
        один раз.
      </p>

      {link ? (
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
          <p className="text-body text-sm break-all select-all">{link}</p>
          <p className="text-subtle text-sm">Скопіюйте його зараз: пізніше побачити посилання ще раз не вийде.</p>
          <div className="flex space-x-3">
            <button onClick={share} className="btn-primary flex-1 py-3 rounded-lg font-medium text-sm">
              {copied ? "Скопійовано" : "Копіювати"}
            </button>
            <button onClick={() => setLink(null)} className="btn-ghost px-4 py-3 rounded-lg text-sm">
              Готово
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={create}
          disabled={busy}
          className="btn-primary w-full py-3 rounded-lg font-medium text-sm disabled:opacity-60"
        >
          {busy ? "Зачекайте..." : "Створити посилання"}
        </button>
      )}

      {error && <p className="text-danger text-sm mt-3">{error}</p>}

      {invites.length > 0 && (
        <div className="mt-5">
          <p className="text-body text-sm mb-1">Чекають на реєстрацію</p>
          <ul className="border-t border-line">
            {invites.map((invite) => (
              <li key={invite.id} className="flex items-center justify-between space-x-3 py-3 border-b border-line">
                <p className="text-subtle text-sm min-w-0">
                  від {invite.createdBy} · діє до {formatDateTime(invite.expiresAt)}
                </p>
                <button
                  onClick={() => revoke(invite.id)}
                  className="shrink-0 text-sm text-muted hover:text-danger transition-colors"
                >
                  Відкликати
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setDone(false);
    if (next.length < MIN_PASSWORD) return setError(`Новий пароль — щонайменше ${MIN_PASSWORD} символів.`);
    if (next !== repeat) return setError("Паролі не збігаються.");
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setRepeat("");
      setDone(true);
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 401 ? "Поточний пароль невірний." : "Не вдалося змінити пароль. Спробуйте ще раз.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="font-geologica font-semibold text-heading uppercase mb-2">Змінити пароль</h2>
      <p className="text-subtle text-sm mb-4">На інших пристроях доведеться увійти знову.</p>
      <form onSubmit={submit} className="space-y-4">
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Поточний пароль"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
          className={FIELD}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder={`Новий пароль (від ${MIN_PASSWORD} символів)`}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
          className={FIELD}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Повторіть новий пароль"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          required
          className={FIELD}
        />
        {error && <p className="text-danger text-sm">{error}</p>}
        {done && <p className="text-accent text-sm">Пароль змінено.</p>}
        <button
          type="submit"
          disabled={busy}
          className="btn-secondary w-full py-3 rounded-lg font-medium text-sm disabled:opacity-60"
        >
          {busy ? "Зачекайте..." : "Змінити пароль"}
        </button>
      </form>
    </section>
  );
}
