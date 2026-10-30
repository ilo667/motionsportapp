"use client";
import { useRef, useState } from "react";
import { api, TrainerInvite } from "@/lib/api";

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("uk-UA", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Kyiv",
  });
}

// «Запросити тренера»: a one-time link (shown once), shared or copied; the invites still waiting, with «Відкликати»
export function InviteSection({ invites, onChange }: { invites: TrainerInvite[]; onChange: () => void }) {
  // The link is shown only right after it is made: the server keeps just a hash of it
  const [link, setLink] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const linkRef = useRef<HTMLParagraphElement>(null);

  const create = async () => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const { id, token } = await api.createTrainerInvite();
      setLink(`${window.location.origin}/admin/join?t=${token}`);
      setLinkId(id);
      onChange();
    } catch {
      setError("Не вдалося створити посилання. Спробуйте ще раз.");
    } finally {
      setBusy(false);
    }
  };

  // «Копіювати» always copies; on Mac browsers navigator.share exists too, so sharing is a separate button
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard access: select the link so it can be copied by hand
      if (linkRef.current) window.getSelection()?.selectAllChildren(linkRef.current);
    }
  };

  const share = async () => {
    if (!link) return;
    try {
      await navigator.share({ title: "Motion Gym", text: "Запрошення тренера в Motion Gym", url: link });
    } catch {
      // The share sheet was closed; nothing to do
    }
  };

  const revoke = async (id: string) => {
    setError("");
    // The link on screen is dead once its invite is revoked
    if (id === linkId) setLink(null);
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
          <p ref={linkRef} className="text-body text-sm break-all select-all">
            {link}
          </p>
          <p className="text-subtle text-sm">Скопіюйте його зараз: пізніше побачити посилання ще раз не вийде.</p>
          <div className="flex space-x-3">
            <button type="button" onClick={copy} className="btn-primary flex-1 py-3 rounded-lg font-medium text-sm">
              {copied ? "Скопійовано" : "Копіювати"}
            </button>
            {"share" in navigator && (
              <button type="button" onClick={share} className="btn-secondary px-4 py-3 rounded-lg font-medium text-sm">
                Поділитися
              </button>
            )}
            <button type="button" onClick={() => setLink(null)} className="btn-ghost px-4 py-3 rounded-lg text-sm">
              Готово
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={create}
          disabled={busy}
          className="btn-primary w-full py-3 rounded-lg font-medium text-sm disabled:opacity-60"
        >
          {busy ? "Зачекайте..." : "Створити посилання"}
        </button>
      )}

      {error && (
        <p role="alert" className="text-danger text-sm mt-3">
          {error}
        </p>
      )}

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
                  type="button"
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
