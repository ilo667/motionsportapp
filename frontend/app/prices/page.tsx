import Link from "next/link";
import type { PriceListItem } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { PriceList } from "@/components/PriceList";

// Rendered on the server and kept for a day: prices change rarely, and saving one in the admin rebuilds the page
// at once (refreshPublicPrices)
export const revalidate = 86400;

// Straight to the backend (the same address the /api rewrite uses): the browser's /api path means nothing here.
// A failure throws, so Next keeps serving the last good page instead of caching an error for a day. Only the
// build has no page to fall back on: it gets the error text, and the next visit after a price save rebuilds it
async function getPrices(): Promise<PriceListItem[] | null> {
  try {
    const res = await fetch(`${process.env.BACKEND_URL ?? "http://localhost:3001"}/prices`, {
      next: { revalidate },
    });
    if (!res.ok) throw new Error(`GET /prices: ${res.status}`);
    return (await res.json()) as PriceListItem[];
  } catch (err) {
    if (process.env.NEXT_PHASE === "phase-production-build") return null;
    throw err;
  }
}

// The gym's prices for clients and visitors, no sign-in needed. The same list the trainer edits in «Ціни»
export default async function PublicPricesPage() {
  const items = await getPrices();

  const back = (
    <Link href="/" className="text-muted text-sm hover:text-body transition-colors">
      ← На головну
    </Link>
  );

  return (
    <PageLayout variant="top" action={back}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">Ціни</h1>
      {items ? <PriceList items={items} /> : <p className="text-danger text-sm">Не вдалося завантажити ціни.</p>}
    </PageLayout>
  );
}
