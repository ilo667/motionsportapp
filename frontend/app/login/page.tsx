"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";

export default function LoginPage() {
  const router = useRouter();
  const [memberCode, setMemberCode] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.login(memberCode.trim().toUpperCase(), pin);
      try { localStorage.setItem('mg_authed', '1'); } catch {}
      router.push("/");
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        setError("Невірний код або PIN.");
      } else {
        const msg = err instanceof Error ? err.message : "Помилка входу.";
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageLayout>
      <h1 className="font-geologica font-semibold text-3xl sm:text-4xl text-heading mb-2">
        Вхід
      </h1>
      <p className="text-body text-sm mb-8">
        Ще немає коду?{" "}
        <Link href="/register" className="text-accent hover:underline">
          Зареєструватись
        </Link>
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-body text-sm mb-1.5">Код учасника</label>
          <input
            type="text"
            value={memberCode}
            onChange={(e) =>
              setMemberCode(e.target.value.toUpperCase())
            }
            required
            autoComplete="username"
            className="input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            placeholder="GYM-12345"
          />
        </div>

        <div>
          <label className="block text-body text-sm mb-1.5">PIN-код</label>
          <input
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={pin}
            onChange={(e) =>
              setPin(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
            required
            autoComplete="current-password"
            className="input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            placeholder="••••••"
          />
        </div>

        {error && <p className="text-danger text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors disabled:opacity-60"
        >
          {loading ? "Зачекайте..." : "Увійти"}
        </button>
      </form>
    </PageLayout>
  );
}