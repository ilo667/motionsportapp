"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/AuthCard";
import { api } from "@/lib/api";

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
    <AuthCard>
      <h1 className="font-geologica font-semibold text-[28px] sm:text-[40px] text-heading mb-2">
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
            className="w-full border border-line rounded-[8px] px-4 py-3 text-sm text-body bg-surface focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
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
            className="w-full border border-line rounded-[8px] px-4 py-3 text-sm text-body bg-surface focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            placeholder="••••••••"
          />
        </div>

        {error && <p className="text-danger text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-[15px] rounded-[8px] bg-teal text-on-teal font-medium text-sm hover:bg-teal-dark transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {loading ? "Зачекайте..." : "Увійти"}
        </button>
      </form>
    </AuthCard>
  );
}