"use client";
import { useState } from "react";
import { api, MyFreeze } from "@/lib/api";
import { errorText } from "@/lib/apiErrors";
import { ddmm } from "@/lib/dates";

// «Мій абонемент»: ask the trainer to freeze everything (club card and trainings) for up to 30 days, take the
// request back, or ask to unfreeze. Nothing changes until the trainer approves
export function FreezeBlock({ data, onChanged }: { data: MyFreeze; onChanged: () => Promise<unknown> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { freeze } = data;

  if (!freeze && !data.canFreeze) return null;

  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await call();
      setConfirming(false);
    } catch (err) {
      setError(errorText(err, "Не вдалося надіслати. Оновіть сторінку й спробуйте ще раз."));
    } finally {
      await onChanged();
      setBusy(false);
    }
  };

  const link = "block mx-auto text-subtle text-xs underline hover:text-body py-2 transition-colors disabled:opacity-60";

  if (!freeze) {
    return (
      <div className="rounded-xl border border-line bg-surface p-4">
        {!confirming ? (
          <button onClick={() => setConfirming(true)} className={link}>
            Заморозити абонемент
          </button>
        ) : (
          <>
            <span className="text-heading font-semibold">Заморозити абонемент?</span>
            <ul className="text-body text-sm mt-2 space-y-1 list-disc pl-5">
              <li>Заморожуються клубна карта і всі тренування, до 30 днів.</li>
              <li>Заморозка почнеться, коли тренер підтвердить запит.</li>
              <li>Ваші записи на тренування в ці дні скасуються.</li>
              <li>Строки подовжаться на стільки днів, скільки тривала заморозка.</li>
              <li>Розморозити раніше можна запитом до тренера.</li>
            </ul>
            <button
              onClick={() => run(api.requestFreeze)}
              disabled={busy}
              className="btn-primary w-full py-3 rounded-lg text-sm mt-4 transition-colors disabled:opacity-60"
            >
              {busy ? "Надсилаємо..." : "Надіслати запит тренеру"}
            </button>
            <button onClick={() => setConfirming(false)} disabled={busy} className={`${link} mt-1`}>
              Скасувати
            </button>
          </>
        )}
        {error && <p className="text-danger text-xs mt-2">{error}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between space-x-3">
        <span className="text-heading font-semibold">Заморозка</span>
        <span className="text-xs font-semibold border rounded-full px-2.5 py-1 whitespace-nowrap text-warn bg-warn-bg border-warn-line">
          {freeze.state === "requested" ? "Чекає тренера" : `До ${ddmm(freeze.until!)}`}
        </span>
      </div>
      {freeze.state === "requested" && (
        <>
          <p className="text-subtle text-xs mt-2">
            Запит на заморозку надіслано. Заморозка почнеться, коли тренер підтвердить.
          </p>
          <button onClick={() => run(api.cancelFreezeRequest)} disabled={busy} className={`${link} mt-2`}>
            Скасувати запит
          </button>
        </>
      )}
      {freeze.state === "active" && (
        <>
          <p className="text-subtle text-xs mt-2">
            Абонемент заморожено до {ddmm(freeze.until!)} включно. Записатися на тренування до того дня не можна; строки
            вже подовжено.
          </p>
          <button
            onClick={() => run(api.requestUnfreeze)}
            disabled={busy}
            className="btn-ghost w-full py-3 rounded-lg border text-sm mt-3 transition-colors disabled:opacity-60"
          >
            {busy ? "Надсилаємо..." : "Розморозити раніше"}
          </button>
        </>
      )}
      {freeze.state === "unfreeze_requested" && (
        <p className="text-subtle text-xs mt-2">
          Запит на розморозку надіслано. Тренер підтвердить, і можна буде записуватись.
        </p>
      )}
      {error && <p className="text-danger text-xs mt-2">{error}</p>}
    </div>
  );
}
