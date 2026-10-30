"use client";
import { useState } from "react";
import { api, Announcement, AnnouncementExample } from "@/lib/api";

// `onMutate` runs a change, reloads the page and shows any error under the trainings
export function AnnouncementSection({
  date,
  announcement,
  examples,
  onMutate,
}: {
  date: string;
  announcement: Announcement | null;
  examples: AnnouncementExample[];
  onMutate: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [newExampleText, setNewExampleText] = useState("");
  const [editingText, setEditingText] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const addExample = async () => {
    if (!newExampleText.trim()) return;
    await onMutate(() => api.addAnnouncementExample(newExampleText.trim()));
    setNewExampleText("");
  };

  return (
    <div className="border-t border-line pt-5 mt-5">
      <p className="text-muted text-xs mb-3 uppercase tracking-wide font-medium">Оголошення</p>

      {announcement?.publishedAt ? (
        <div className="bg-teal/8 border border-teal/20 rounded-xl px-4 py-3 mb-4 text-sm text-body">
          <p className="font-medium text-teal mb-1 text-xs">✓ Опубліковано</p>
          {announcement.text}
        </div>
      ) : announcement?.text ? (
        <div className="bg-surface border border-line rounded-xl px-4 py-3 mb-4 text-sm text-muted">
          <p className="font-medium text-xs mb-1">Чернетка (не опубліковано)</p>
          {announcement.text}
        </div>
      ) : null}

      {editingText !== null ? (
        <div className="mb-3 space-y-2">
          <textarea
            value={editingText}
            onChange={(e) => setEditingText(e.target.value)}
            rows={3}
            className="input-field w-full rounded-lg border px-3 py-2 text-sm resize-none focus:outline-none focus:border-teal"
            placeholder="Текст оголошення..."
          />
          <div className="flex space-x-2">
            <button
              type="button"
              onClick={async () => {
                await onMutate(() => api.updateAnnouncementText(date, editingText));
                setEditingText(null);
              }}
              className="btn-primary flex-1 py-2 rounded-lg text-sm transition-colors"
            >
              Зберегти
            </button>
            <button
              type="button"
              onClick={() => setEditingText(null)}
              className="btn-ghost flex-1 py-2 rounded-lg border text-sm transition-colors"
            >
              Скасувати
            </button>
          </div>
        </div>
      ) : null}

      <div className="-m-1 flex flex-wrap mb-4">
        <button
          type="button"
          disabled={generating}
          onClick={async () => {
            setGenerating(true);
            await onMutate(() => api.generateAnnouncement(date));
            setGenerating(false);
          }}
          className="m-1 btn-secondary py-2 px-3 rounded-lg border text-sm transition-colors disabled:opacity-50"
        >
          {generating ? "Генерую..." : "✨ Згенерувати AI"}
        </button>
        {announcement?.text && !announcement.publishedAt && (
          <>
            <button
              type="button"
              onClick={() => setEditingText(announcement.text ?? "")}
              className="m-1 btn-ghost py-2 px-3 rounded-lg border text-sm transition-colors"
            >
              Редагувати
            </button>
            <button
              type="button"
              onClick={() => onMutate(() => api.publishAnnouncement(date))}
              className="m-1 btn-primary py-2 px-3 rounded-lg text-sm transition-colors"
            >
              Опублікувати
            </button>
          </>
        )}
        {announcement?.publishedAt && (
          <button
            type="button"
            onClick={() => onMutate(() => api.unpublishAnnouncement(date))}
            className="m-1 btn-ghost hover-danger py-2 px-3 rounded-lg border text-sm transition-colors"
          >
            Зняти з публікації
          </button>
        )}
      </div>

      <p className="text-muted text-xs mb-2 font-medium">Приклади стилю для AI</p>
      <div className="space-y-2 mb-3">
        {examples.map((ex) => (
          <div key={ex.id} className="flex items-start space-x-2 bg-surface rounded-lg px-3 py-2">
            <p className="flex-1 text-sm text-body">{ex.text}</p>
            <button
              type="button"
              onClick={() => onMutate(() => api.deleteAnnouncementExample(ex.id))}
              className="text-muted hover:text-danger text-xs shrink-0 mt-0.5 transition-colors"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="flex space-x-2">
        <input
          type="text"
          value={newExampleText}
          onChange={(e) => setNewExampleText(e.target.value)}
          placeholder="Додати приклад оголошення..."
          className="input-field flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:border-teal"
          onKeyDown={(e) => {
            if (e.key === "Enter") addExample();
          }}
        />
        <button
          type="button"
          onClick={addExample}
          className="btn-primary py-2 px-3 rounded-lg text-sm transition-colors"
        >
          +
        </button>
      </div>
    </div>
  );
}
