"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { PageLayout } from "@/components/PageLayout";

function ReturnContent() {
  const params = useSearchParams();
  const order = params.get("order");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void order;
    const timer = setTimeout(() => setReady(true), 2000);
    return () => clearTimeout(timer);
  }, [order]);

  if (!ready) return null;

  return (
    <div className="text-center space-y-4">
      <div className="text-4xl mb-2">✓</div>
      <h1 className="font-geologica font-semibold text-title text-heading uppercase">
        Дякуємо!
      </h1>
      <p className="text-muted text-sm">
        Якщо оплата пройшла успішно — ваше місце підтверджено.
        Перевірте статус у розкладі.
      </p>
      <Link
        href="/"
        className="inline-block btn-primary px-6 py-3 rounded-xl text-sm font-medium transition-colors"
      >
        До розкладу →
      </Link>
    </div>
  );
}

export default function PaymentReturnPage() {
  return (
    <PageLayout variant="centered">
      <Suspense fallback={
        <div className="flex-1 flex items-center justify-center">
          <span className="text-muted text-sm">Завантаження...</span>
        </div>
      }>
        <ReturnContent />
      </Suspense>
    </PageLayout>
  );
}
