"use client";
import { useState } from "react";
import { api, Trainer, statusOf } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";

const FIELD = "input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none";

// «Вимкнути»: whom the trainer's clients go to, what happens, and the irreversible button
export function DisableDialog({
  trainer,
  targets,
  onClose,
  onConflict,
  onDone,
}: {
  trainer: Trainer;
  targets: Trainer[];
  onClose: () => void;
  onConflict: () => void;
  onDone: (text: string) => void;
}) {
  const [transferToId, setTransferToId] = useState(targets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const disable = async () => {
    setBusy(true);
    setError("");
    try {
      const { movedClients, cancelledTrainings } = await api.disableTrainer(trainer.id, transferToId);
      onDone(`Вимкнено. Клієнтів передано: ${movedClients}, тренувань скасовано: ${cancelledTrainings}`);
    } catch (err) {
      const conflict = statusOf(err) === 409;
      setError(conflict ? "Цього тренера вже вимкнули" : "Не вдалося вимкнути. Спробуйте ще раз.");
      if (conflict) onConflict();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal variant="card" onDismiss={onClose} labelledBy="disable-trainer-title">
      <p id="disable-trainer-title" className="font-geologica font-semibold text-heading">
        Вимкнути {trainer.username}?
      </p>
      <div>
        <label htmlFor="transfer-to" className="block text-muted text-xs mb-2 uppercase tracking-wide">
          Клієнти перейдуть до
        </label>
        <select
          id="transfer-to"
          value={transferToId}
          onChange={(e) => setTransferToId(e.target.value)}
          className={FIELD}
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.username}
            </option>
          ))}
        </select>
      </div>
      <p className="text-body text-sm">
        {trainer.username} більше не зможе увійти. Його клієнти й готівкові оплати, які чекають на підтвердження,
        перейдуть до обраного тренера. Тренування, що ще не закінчились, буде скасовано, а записані клієнти отримають
        сповіщення. Вимкнення не можна скасувати.
      </p>
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
      <div className="flex flex-col space-y-2">
        <button
          type="button"
          onClick={disable}
          disabled={busy || !transferToId}
          className="btn-ghost hover-danger w-full py-3 rounded-lg border border-danger text-danger text-sm transition-colors disabled:opacity-60"
        >
          {busy ? "Зачекайте..." : "Вимкнути"}
        </button>
        <button type="button" onClick={onClose} className="text-muted text-sm py-2 transition-colors hover:text-body">
          Закрити
        </button>
      </div>
    </Modal>
  );
}
