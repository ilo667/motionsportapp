import Link from "next/link";
import { PageLayout } from "@/components/PageLayout";

// Any unknown URL (and notFound() calls). Rendered inside the root layout
export default function NotFound() {
  return (
    <PageLayout className="items-center text-center">
      <p className="font-geologica font-semibold text-display text-accent mb-2">404</p>
      <h1 className="font-geologica font-semibold text-title text-heading uppercase mb-3">
        Сторінку не знайдено
      </h1>
      <p className="text-muted text-sm mb-8">Можливо, посилання застаріло або в ньому помилка.</p>
      <div className="w-full max-w-xs mx-auto">
        <Link href="/" className="btn-primary block w-full py-4 rounded-lg font-medium text-sm transition-colors text-center">
          На головну
        </Link>
      </div>
    </PageLayout>
  );
}
