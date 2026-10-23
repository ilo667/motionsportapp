"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, PriceChange, PriceItem, PriceSection } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { AdminMenu } from "@/components/admin/AdminMenu";

const SECTIONS: { key: PriceSection; title: string; note?: string }[] = [
  { key: "club_card", title: "Клубні карти" },
  { key: "assigned", title: "Послуги тренера", note: "Ціна без урахування вартості клубної карти" },
  { key: "group", title: "Групові заняття" },
];
// Same limit as UpdatePriceDto on the backend
const MAX_PRICE_UAH = 100_000;

const formatUah = (v: number) => `${v.toLocaleString("uk-UA")} ₴`;
const itemName = (p: { title: string; optionLabel: string | null }) =>
  p.optionLabel ? `${p.title} · ${p.optionLabel}` : p.title;
const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString("uk-UA", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Kyiv",
  });

// Options of one section grouped under their title ("Повний день": 1 / 3 / 6 місяців), in page order
function groupByTitle(items: PriceItem[]) {
  const groups: { title: string; options: PriceItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last?.title === item.title) last.options.push(item);
    else groups.push({ title: item.title, options: [item] });
  }
  return groups;
}

function ConfirmModal({
  item,
  amountUah,
  saving,
  onConfirm,
  onDismiss,
}: {
  item: PriceItem;
  amountUah: number;
  saving: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onDismiss(); }}
    >
      <div className="absolute inset-0 bg-black/40 pointer-events-none" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="price-confirm-title"
        className="relative w-full max-w-[480px] mx-auto bg-surface rounded-t-[20px] sm:rounded-2xl px-5 pt-6 pb-8 shadow-xl border border-line"
      >
        <h2 id="price-confirm-title" className="font-geologica font-semibold text-lg text-heading mb-2">
          {itemName(item)}
        </h2>
        <p className="font-geologica text-2xl text-heading tabular-nums">
          <s className="text-muted text-lg mr-2">{formatUah(item.amountUah)}</s>
          {formatUah(amountUah)}
        </p>
        <p className="mt-3 mb-5 rounded-xl border border-line bg-background px-3 py-2.5 text-sm text-body">
          Ціна зміниться <span className="text-heading font-medium">для всіх тренерів</span>. В історії буде
          видно, що її змінили ви.
        </p>
        <div className="flex flex-col space-y-2">
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={saving}
            className="btn-primary w-full py-3 rounded-xl text-sm font-medium transition-colors disabled:opacity-60"
          >
            {saving ? "Збереження..." : "Так, змінити для всіх"}
          </button>
          <button
            onClick={onDismiss}
            disabled={saving}
            className="btn-ghost w-full py-3 rounded-xl border text-sm transition-colors"
          >
            Скасувати
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PricesPage() {
  const router = useRouter();
  const [items, setItems] = useState<PriceItem[] | null>(null);
  const [changes, setChanges] = useState<PriceChange[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{ item: PriceItem; amountUah: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () =>
      api
        .getPrices()
        .then(({ items, changes }) => {
          setItems(items);
          setChanges(changes);
        })
        .catch((err: unknown) => {
          const status = (err as { status?: number }).status;
          if (status === 401 || status === 403) router.push("/admin/login");
          else setLoadError(true);
        }),
    [router],
  );

  useEffect(() => { load(); }, [load]);

  const startEdit = (item: PriceItem) => {
    setEditingId(item.id);
    setDraft(String(item.amountUah));
    setError("");
  };
  const stopEdit = () => {
    setEditingId(null);
    setError("");
  };

  const askConfirm = (item: PriceItem) => {
    const amountUah = Number(draft);
    if (!draft || !Number.isInteger(amountUah) || amountUah < 1 || amountUah > MAX_PRICE_UAH) {
      setError("Вкажіть ціле число від 1 до 100 000.");
      return;
    }
    if (amountUah === item.amountUah) return stopEdit();
    setError("");
    setConfirm({ item, amountUah });
  };

  const dismissConfirm = useCallback(() => setConfirm(null), []);

  const save = async () => {
    if (!confirm) return;
    setSaving(true);
    try {
      await api.updatePrice(confirm.item.id, confirm.amountUah, confirm.item.amountUah);
      setConfirm(null);
      stopEdit();
      await load();
    } catch (err) {
      const { status, body } = err as { status?: number; body?: { amountUah?: number; updatedBy?: string | null } };
      setConfirm(null);
      if (status === 409 && body?.amountUah !== undefined) {
        // Another coach got there first: show their amount and let this coach decide again
        setError(`Ціну щойно змінив ${body.updatedBy ?? "інший тренер"}: ${formatUah(body.amountUah)}.`);
        await load();
      } else {
        setError("Не вдалося зберегти. Спробуйте ще раз.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageLayout variant="top" loading={!items && !loadError} action={<AdminMenu />}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-2">Ціни</h1>
      <p className="text-muted text-xs mb-6">Один прайс для всіх тренерів. Натисніть на ціну, щоб змінити.</p>

      {loadError && <p className="text-danger text-sm">Не вдалося завантажити ціни.</p>}

      {items && (
        <div className="flex flex-col space-y-8">
          {SECTIONS.map((section) => {
            const groups = groupByTitle(items.filter((i) => i.section === section.key));
            if (groups.length === 0) return null;
            return (
              <section key={section.key}>
                <h2 className="font-geologica font-semibold text-heading uppercase mb-1">{section.title}</h2>
                {section.note && <p className="text-muted text-xs mb-2">{section.note}</p>}
                <div className="border-t border-line">
                  {groups.map((group) => (
                    <div key={group.title} className="py-3 border-b border-line">
                      <div className="text-heading font-medium mb-1">{group.title}</div>
                      {group.options.map((item) =>
                        editingId === item.id ? (
                          <div key={item.id} className="py-1">
                            <div className="flex items-center justify-between space-x-3">
                              <span className="text-body">{item.optionLabel}</span>
                              <div className="flex items-center space-x-2">
                                <input
                                  autoFocus
                                  inputMode="numeric"
                                  aria-label={`Нова ціна: ${itemName(item)}, ₴`}
                                  value={draft}
                                  onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") askConfirm(item);
                                    if (e.key === "Escape") stopEdit();
                                  }}
                                  className="input-field w-24 border rounded-lg px-2 py-1 text-right tabular-nums focus:outline-none"
                                />
                                <button
                                  onClick={() => askConfirm(item)}
                                  className="btn-primary px-3 py-1 rounded-lg text-xs font-medium transition-colors"
                                >
                                  Зберегти
                                </button>
                                <button
                                  onClick={stopEdit}
                                  aria-label="Скасувати"
                                  className="btn-ghost px-2 py-1 rounded-lg border text-xs transition-colors"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                            {error && <p className="text-danger text-xs text-right mt-1">{error}</p>}
                          </div>
                        ) : (
                          <div key={item.id} className="flex items-center justify-between space-x-3 py-0.5">
                            <span className="text-body">
                              {item.optionLabel}
                              {item.updatedBy && item.updatedAt && (
                                <span className="text-muted text-xs ml-2">
                                  {item.updatedBy}, {formatWhen(item.updatedAt)}
                                </span>
                              )}
                            </span>
                            <button
                              onClick={() => startEdit(item)}
                              aria-label={`Змінити ціну: ${itemName(item)}`}
                              className="font-geologica text-heading tabular-nums whitespace-nowrap rounded-lg border border-transparent px-2 py-1 -mr-2 hover:border-line hover:bg-surface transition-colors"
                            >
                              {formatUah(item.amountUah)}
                            </button>
                          </div>
                        ),
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          <section>
            <h2 className="font-geologica font-semibold text-heading uppercase mb-2">Історія змін</h2>
            {changes.length === 0 ? (
              <p className="text-muted text-sm">Ціни ще ніхто не змінював.</p>
            ) : (
              <ul className="border-t border-line">
                {changes.map((c) => (
                  <li key={c.id} className="py-2 border-b border-line">
                    <div className="text-heading tabular-nums">
                      {itemName(c)}: {formatUah(c.oldAmountUah)} → {formatUah(c.newAmountUah)}
                    </div>
                    <div className="text-muted text-xs">
                      {c.changedBy}, {formatWhen(c.changedAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {confirm && (
        <ConfirmModal
          item={confirm.item}
          amountUah={confirm.amountUah}
          saving={saving}
          onConfirm={save}
          onDismiss={dismissConfirm}
        />
      )}
    </PageLayout>
  );
}
