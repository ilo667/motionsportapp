import Link from "next/link";
import { PageLayout } from "@/components/PageLayout";

export default function PaymentReturnPage() {
  return (
    <PageLayout className="items-center text-center">
      <div className="text-4xl text-accent mb-3">✓</div>
      <h1 className="font-geologica font-semibold text-title text-heading mb-2 uppercase">
        Платіж прийнято
      </h1>
      <p className="text-muted text-sm">Ваш запис підтверджено.</p>
      <div className="flex flex-col w-full max-w-xs mt-10">
        <Link href="/" className="btn-primary w-full py-4 rounded-lg font-medium text-sm transition-colors text-center">
          До розкладу
        </Link>
      </div>
    </PageLayout>
  );
}