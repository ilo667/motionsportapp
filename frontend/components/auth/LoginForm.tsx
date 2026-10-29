"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, statusOf } from "@/lib/api";
import { PageLayout } from "@/components/ui/PageLayout";
import { errorText } from "@/lib/apiErrors";

interface FieldConfig {
  label: string;
  type: "text" | "password";
  autoComplete: string;
  placeholder: string;
  inputMode?: "numeric";
  maxLength?: number;
  normalize?: (value: string) => string;
}

interface VariantConfig {
  title: string;
  subtitle?: ReactNode;
  footer?: ReactNode;
  login: FieldConfig;
  secret: FieldConfig;
  submit: (login: string, secret: string) => Promise<unknown>;
  redirectTo: string;
  invalidCredentials: string;
}

const VARIANTS: Record<"member" | "admin", VariantConfig> = {
  member: {
    title: "Вхід",
    subtitle: (
      <>
        Ще немає коду?{" "}
        <Link href="/register" className="text-accent hover:underline">
          Зареєструватись
        </Link>
      </>
    ),
    footer: (
      <Link href="/forgot" className="text-accent hover:underline">
        Забули PIN?
      </Link>
    ),
    login: {
      label: "Код учасника",
      type: "text",
      autoComplete: "username",
      placeholder: "GYM-12345",
      normalize: (v) => v.toUpperCase(),
    },
    secret: {
      label: "PIN-код",
      type: "password",
      autoComplete: "current-password",
      placeholder: "••••••",
      inputMode: "numeric",
      maxLength: 6,
      normalize: (v) => v.replace(/\D/g, "").slice(0, 6),
    },
    submit: (login, secret) => api.login(login.trim().toUpperCase(), secret),
    redirectTo: "/",
    invalidCredentials: "Невірний код або PIN.",
  },
  admin: {
    title: "Тренер",
    login: {
      label: "Логін",
      type: "text",
      autoComplete: "username",
      placeholder: "admin",
    },
    secret: {
      label: "Пароль",
      type: "password",
      autoComplete: "current-password",
      placeholder: "••••••••",
    },
    submit: (login, secret) => api.adminLogin(login.trim(), secret),
    redirectTo: "/admin",
    invalidCredentials: "Невірний логін або пароль.",
  },
};

function Field({ config, value, onChange }: { config: FieldConfig; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-body text-sm mb-1.5">{config.label}</label>
      <input
        type={config.type}
        inputMode={config.inputMode}
        maxLength={config.maxLength}
        value={value}
        onChange={(e) => onChange(config.normalize ? config.normalize(e.target.value) : e.target.value)}
        required
        autoComplete={config.autoComplete}
        className="input-field w-full border rounded-lg px-4 py-3 text-sm focus:outline-none"
        placeholder={config.placeholder}
      />
    </div>
  );
}

export function LoginForm({ variant }: { variant: "member" | "admin" }) {
  const config = VARIANTS[variant];
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await config.submit(login, secret);
      try {
        localStorage.setItem("mg_authed", "1");
      } catch {}
      router.push(config.redirectTo);
    } catch (err: unknown) {
      const status = statusOf(err);
      if (status === 401) {
        setError(config.invalidCredentials);
      } else {
        setError(errorText(err, "Помилка входу."));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageLayout>
      <Link href="/" className="inline-flex items-center text-sm text-subtle hover:text-body transition-colors mb-6">
        ← Назад
      </Link>
      <h1
        className={`font-geologica font-semibold text-title sm:text-display text-heading uppercase ${config.subtitle ? "mb-2" : "mb-8"}`}
      >
        {config.title}
      </h1>
      {config.subtitle && <p className="text-body text-sm mb-8">{config.subtitle}</p>}

      <form onSubmit={handleSubmit} className="space-y-5">
        <Field config={config.login} value={login} onChange={setLogin} />
        <Field config={config.secret} value={secret} onChange={setSecret} />

        {error && <p className="text-danger text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors disabled:opacity-60"
        >
          {loading ? "Зачекайте..." : "Увійти"}
        </button>

        {config.footer && <p className="text-center text-sm text-muted">{config.footer}</p>}
      </form>
    </PageLayout>
  );
}
