"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";

export default function ForgotPage() {
  const router = useRouter();
  const [memberCode, setMemberCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ memberCode: string; recoveryCode: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setPinError("");

    if (!/^\d{6}$/.test(newPin)) {
      setPinError("PIN має містити рівно 6 цифр.");
      return;
    }

    setLoading(true);
    try {
      const data = await api.forgotPin(memberCode.trim().toUpperCase(), recoveryCode.trim(), newPin);
      try {
        localStorage.setItem("mg_authed", "1");
      } catch {}
      setResult(data);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        setError("Невірний код учасника або код відновлення.");
      } else {
        const msg = err instanceof Error ? err.message : "Помилка. Спробуйте ще раз.";
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  if (result) {
    return (
      <PageLayout>
        <h1 className="font-geologica font-semibold text-3xl sm:text-4xl text-heading mb-2">PIN змінено</h1>
        <p className="text-muted text-sm mb-6">Збережіть новий код відновлення — він більше не буде показаний.</p>

        <div className="bg-surface rounded-xl p-5 mb-4">
          <p className="text-muted text-xs mb-1">Новий код відновлення</p>
          <div className="flex items-center justify-between space-x-2">
            <span className="font-mono text-sm text-body break-all">{result.recoveryCode}</span>
            <button
              onClick={() => copyToClipboard(result.recoveryCode)}
              className="text-accent text-sm hover:underline shrink-0"
            >
              {copied ? "Скопійовано ✓" : "Копіювати"}
            </button>
          </div>
        </div>

        <p className="text-danger text-sm mb-6">
          ⚠ Збережіть код відновлення зараз. Він потрібен якщо знову забудете PIN.
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
      <h1 className="font-geologica font-semibold text-3xl sm:text-4xl text-heading mb-2">Відновлення PIN</h1>
      <p className="text-body text-sm mb-8">
        Згадали PIN?{" "}
        <Link href="/login" className="text-accent hover:underline">
          Увійти
        </Link>
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-body text-sm mb-1.5">Код учасника</label>
          <input
            type="text"
            value={memberCode}
            onChange={(e) => setMemberCode(e.target.value.toUpperCase())}
            required
            autoComplete="username"
            className="input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none"
            placeholder="GYM-12345"
          />
        </div>

        <div>
          <label className="block text-body text-sm mb-1.5">Код відновлення</label>
          <input
            type="text"
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            required
            autoComplete="off"
            className="input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none font-mono"
            placeholder="xxxx-xxxx-xxxx"
          />
        </div>

        <div>
          <label className="block text-body text-sm mb-1.5">Новий PIN-код (6 цифр)</label>
          <input
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={newPin}
            onChange={(e) => {
              setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6));
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
          {loading ? "Зачекайте..." : "Відновити PIN"}
        </button>
      </form>
    </PageLayout>
  );
}
