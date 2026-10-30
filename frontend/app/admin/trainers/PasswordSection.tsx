"use client";
import { useState } from "react";
import { api, statusOf } from "@/lib/api";

const FIELD = "input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none";
const MIN_PASSWORD = 10;

// Own password only; the trainer's other sessions are revoked
export function PasswordSection() {
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
    if (next.length < MIN_PASSWORD) return setError(`Новий пароль: щонайменше ${MIN_PASSWORD} символів.`);
    if (next !== repeat) return setError("Паролі не збігаються.");
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setRepeat("");
      setDone(true);
    } catch (err) {
      setError(statusOf(err) === 401 ? "Поточний пароль невірний." : "Не вдалося змінити пароль. Спробуйте ще раз.");
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
        {error && (
          <p role="alert" className="text-danger text-sm">
            {error}
          </p>
        )}
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
