"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, statusOf } from "@/lib/api";
import { PageLayout } from "@/components/ui/PageLayout";

const FIELD = "input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none";
const MIN_PASSWORD = 10;

export function TrainerJoinForm({ token }: { token: string }) {
  const router = useRouter();
  // null while checking the link
  const [valid, setValid] = useState<boolean | null>(token ? null : false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    api
      .checkTrainerInvite(token)
      .then(({ valid }) => setValid(valid))
      .catch(() => setValid(false));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!/^[a-z0-9._-]{3,32}$/.test(username))
      return setError("Логін: від 3 до 32 символів, латинські літери, цифри, крапка, _ або -.");
    if (password.length < MIN_PASSWORD) return setError(`Пароль: щонайменше ${MIN_PASSWORD} символів.`);
    if (password !== repeat) return setError("Паролі не збігаються.");
    setLoading(true);
    try {
      await api.registerTrainer(token, username, password);
      try {
        localStorage.setItem("mg_authed", "1");
      } catch {}
      router.push("/admin");
    } catch (err) {
      const status = statusOf(err);
      if (status === 409) setError("Такий логін уже є. Оберіть інший.");
      else if (status === 400) setValid(false);
      else setError("Не вдалося зареєструватися. Спробуйте ще раз.");
    } finally {
      setLoading(false);
    }
  };

  if (valid === null) return <PageLayout loading />;

  if (!valid) {
    return (
      <PageLayout>
        <div className="text-center">
          <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-4">
            Посилання недійсне
          </h1>
          <p className="text-body text-sm mb-8">
            Його вже використали, відкликали або минуло 7 днів. Попросіть тренера надіслати нове.
          </p>
          <Link href="/admin/login" className="text-accent hover:underline text-sm">
            Вхід для тренера
          </Link>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-2">
        Новий тренер
      </h1>
      <p className="text-body text-sm mb-8">Придумайте логін і пароль. З ними ви будете входити в Motion Gym.</p>

      <form onSubmit={submit} className="space-y-5">
        <div>
          <label className="block text-body text-sm mb-1.5">Логін</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().trim())}
            required
            autoComplete="username"
            autoCapitalize="none"
            maxLength={32}
            placeholder="olena"
            className={FIELD}
          />
        </div>
        <div>
          <label className="block text-body text-sm mb-1.5">Пароль</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            placeholder={`від ${MIN_PASSWORD} символів`}
            className={FIELD}
          />
        </div>
        <div>
          <label className="block text-body text-sm mb-1.5">Повторіть пароль</label>
          <input
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            required
            autoComplete="new-password"
            placeholder="••••••••••"
            className={FIELD}
          />
        </div>

        {error && (
          <p role="alert" className="text-danger text-sm">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors disabled:opacity-60"
        >
          {loading ? "Зачекайте..." : "Зареєструватися"}
        </button>
      </form>
    </PageLayout>
  );
}
