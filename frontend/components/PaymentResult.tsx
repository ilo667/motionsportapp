"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, PaymentStatus } from "@/lib/api";
import { PageLayout } from "./PageLayout";

// Backend asks LiqPay on each call while PENDING, so a few short retries cover a late callback
const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 5;

// REJECTED: LiqPay declined an attempt (try_again) but the order is still open, so the booking is kept
type ResultState = PaymentStatus | "UNKNOWN" | "REJECTED";

const REJECT_REASONS: Record<string, string> = {
  limit: "Перевищено ліміт картки.",
};

const CONTENT: Record<Exclude<ResultState, "PENDING" | "REJECTED">, { icon: string; iconClass: string; title: string; text: string }> = {
  PAID: {
    icon: "✓",
    iconClass: "text-accent",
    title: "Платіж прийнято",
    text: "Ваш запис підтверджено.",
  },
  FAILED: {
    icon: "✕",
    iconClass: "text-danger",
    title: "Оплата не пройшла",
    text: "Кошти не списано, запис скасовано. Можете спробувати ще раз з розкладу.",
  },
  EXPIRED: {
    icon: "✕",
    iconClass: "text-danger",
    title: "Час оплати минув",
    text: "Запис скасовано. Можете записатись ще раз з розкладу.",
  },
  REPLACED: {
    icon: "?",
    iconClass: "text-muted",
    title: "Оплату перезапущено",
    text: "Ви почали нову спробу оплати. Статус запису видно в розкладі.",
  },
  UNKNOWN: {
    icon: "?",
    iconClass: "text-muted",
    title: "Не вдалося перевірити оплату",
    text: "Статус запису видно в розкладі.",
  },
};

const PENDING_CONTENT = {
  icon: "…",
  iconClass: "text-amber-400",
  title: "Оплату не завершено",
  text: "Якщо ви не завершили оплату, запис скасується автоматично через 15 хвилин.",
};

export function PaymentResult({ orderId }: { orderId?: string }) {
  const [state, setState] = useState<ResultState | null>(orderId ? null : "UNKNOWN");
  const [errCode, setErrCode] = useState<string>();

  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const check = async (attempt: number) => {
      try {
        const { status, errCode } = await api.getPaymentStatus(orderId);
        if (cancelled) return;
        if (status === "PENDING" && errCode) {
          setErrCode(errCode);
          setState("REJECTED");
          return;
        }
        if (status === "PENDING" && attempt < MAX_ATTEMPTS) {
          timer = setTimeout(() => check(attempt + 1), POLL_INTERVAL_MS);
          return;
        }
        setState(status);
      } catch {
        if (!cancelled) setState("UNKNOWN");
      }
    };

    check(1);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [orderId]);

  if (state === null) return <PageLayout loading />;

  const { icon, iconClass, title, text } =
    state === "REJECTED"
      ? {
          icon: "✕",
          iconClass: "text-danger",
          title: "Оплата не пройшла",
          text: `${REJECT_REASONS[errCode ?? ""] ?? "Банк відхилив платіж."} Спробуйте ще раз або іншою карткою — місце за вами ще 15 хвилин.`,
        }
      : state === "PENDING"
        ? PENDING_CONTENT
        : CONTENT[state];

  return (
    <PageLayout className="items-center text-center">
      <div className={`text-4xl mb-3 ${iconClass}`}>{icon}</div>
      <h1 className="font-geologica font-semibold text-title text-heading mb-2 uppercase">{title}</h1>
      <p className="text-muted text-sm">{text}</p>
      <div className="flex flex-col w-full max-w-xs mx-auto mt-10">
        <Link href="/" className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors text-center">
          {state === "REJECTED" ? "Спробувати ще раз" : "До розкладу"}
        </Link>
      </div>
    </PageLayout>
  );
}
