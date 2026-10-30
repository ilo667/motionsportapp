"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { PageLayout } from "@/components/ui/PageLayout";
import { errorText } from "@/lib/apiErrors";

export default function RegisterPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [pinError, setPinError] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    memberCode: string;
    recoveryCode: string;
  } | null>(null);

  const [copied, setCopied] = useState<"code" | "recovery" | null>(null);

  const copyToClipboard = async (text: string, key: "code" | "recovery") => {
    // No clipboard (an old browser, a page not on https): no «Скопійовано», the code stays on screen to copy by hand
    const ok = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    if (!ok) return;
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setPinError("");

    if (!/^\d{6}$/.test(pin)) {
      setPinError("PIN має містити рівно 6 цифр.");
      return;
    }

    setLoading(true);
    try {
      const data = await api.register(displayName.trim(), pin);
      setResult(data);
    } catch (err: unknown) {
      setError(errorText(err, "Помилка реєстрації."));
    } finally {
      setLoading(false);
    }
  };

  if (result) {
    return (
      <PageLayout>
        <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-2">
          Вітаємо!
        </h1>
        <p className="text-muted text-sm mb-6">Збережіть ці дані. Код відновлення більше не покажеться.</p>

        <div className="bg-surface rounded-xl p-5 mb-4 space-y-4">
          <div>
            <p className="text-muted text-xs mb-1">Ваш код учасника</p>
            <div className="flex items-center justify-between">
              <span className="font-geologica font-semibold text-xl text-heading">{result.memberCode}</span>
              <button
                onClick={() => copyToClipboard(result.memberCode, "code")}
                className="text-accent text-sm hover:underline ml-2"
              >
                {copied === "code" ? "Скопійовано ✓" : "Копіювати"}
              </button>
            </div>
          </div>

          <div>
            <p className="text-muted text-xs mb-1">Код відновлення</p>
            <div className="flex items-center justify-between space-x-2">
              <span className="font-mono text-sm text-body break-all">{result.recoveryCode}</span>
              <button
                onClick={() => copyToClipboard(result.recoveryCode, "recovery")}
                className="text-accent text-sm hover:underline shrink-0"
              >
                {copied === "recovery" ? "Скопійовано ✓" : "Копіювати"}
              </button>
            </div>
          </div>
        </div>

        <p className="text-danger text-sm mb-6">
          ⚠ Збережіть код відновлення зараз. Якщо забудете PIN, він потрібен для відновлення доступу.
        </p>

        <button
          onClick={() => router.push("/")}
          className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors"
        >
          Продовжити →
        </button>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-2">
        Реєстрація
      </h1>
      <p className="text-body text-sm mb-8">
        Вже є код?{" "}
        <Link href="/login" className="text-accent hover:underline">
          Увійти
        </Link>
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-body text-sm mb-1.5">{"Ваше ім'я"}</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            autoComplete="name"
            className="input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none"
            placeholder="Іван"
          />
        </div>

        <div>
          <label className="block text-body text-sm mb-1.5">PIN-код (6 цифр)</label>
          <input
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, "").slice(0, 6));
              setPinError("");
            }}
            required
            autoComplete="new-password"
            className="input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none"
            placeholder="••••••"
          />
          {pinError && <p className="text-danger text-xs mt-1">{pinError}</p>}
        </div>

        {error && <p className="text-danger text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors disabled:opacity-60"
        >
          {loading ? "Зачекайте..." : "Зареєструватись"}
        </button>
      </form>
    </PageLayout>
  );
}
