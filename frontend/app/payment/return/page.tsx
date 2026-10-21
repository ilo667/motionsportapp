"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { MotionGymLogo } from "@/components/MotionGymLogo";

export default function PaymentReturnPage() {
  const router = useRouter();

  useEffect(() => {
    const t = setTimeout(() => router.push("/"), 3000);
    return () => clearTimeout(t);
  }, [router]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 text-center">
      <MotionGymLogo />
      <div className="space-y-2">
        <div className="text-4xl">✓</div>
        <h1 className="font-geologica text-heading text-2xl">Платіж прийнято</h1>
        <p className="text-muted text-sm">Ваш запис підтверджено. Повертаємось до розкладу…</p>
      </div>
      <button
        onClick={() => router.push("/")}
        className="btn-primary px-6 py-3 rounded-lg text-sm"
      >
        До розкладу
      </button>
    </div>
  );
}
