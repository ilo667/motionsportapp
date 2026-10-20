"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";

export default function AdminLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.adminLogin(username.trim(), password);
      try { localStorage.setItem('mg_authed', '1'); } catch {}
      router.push("/admin");
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        setError("Невірний логін або пароль.");
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
      <Link href="/" className="inline-flex items-center text-sm text-muted hover:text-body transition-colors mb-6">
        ← Назад
      </Link>
      <h1 className="font-geologica font-semibold text-3xl sm:text-4xl text-heading mb-2">
        Адмін
      </h1>
      <p className="text-muted text-sm mb-8">Вхід для тренера</p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-body text-sm mb-1.5">Логін</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
            className="input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none"
            placeholder="admin"
          />
        </div>

        <div>
          <label className="block text-body text-sm mb-1.5">Пароль</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none"
            placeholder="••••••••"
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