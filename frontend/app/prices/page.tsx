import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { PriceListItem } from "@/lib/api";
import { PageLayout } from "@/components/PageLayout";
import { PriceList } from "@/components/PriceList";

// Straight to the backend (the same address the /api rewrite uses): the browser's /api path means nothing on the
// server, and the browser's session cookie has to be passed on by hand. Only `session`, nothing else the browser sent
async function getPrices(session: string): Promise<PriceListItem[] | "signed-out" | null> {
  try {
    const res = await fetch(`${process.env.BACKEND_URL ?? "http://localhost:3001"}/prices`, {
      headers: { Cookie: `session=${session}` },
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) return "signed-out";
    return res.ok ? ((await res.json()) as PriceListItem[]) : null;
  } catch {
    return null;
  }
}

// The gym's prices for a signed-in client (a visitor or a trainer goes to the client login). Rendered on the
// server per request: the same list the trainer edits in «Ціни», always current
export default async function PricesPage() {
  const session = (await cookies()).get("session")?.value;
  const items = session ? await getPrices(session) : "signed-out";
  if (items === "signed-out") redirect("/login");

  const back = (
    <Link href="/purchases" className="text-muted text-sm hover:text-body transition-colors">
      ← Мій абонемент
    </Link>
  );

  return (
    <PageLayout variant="top" action={back}>
      <h1 className="font-geologica font-semibold text-title sm:text-display text-heading uppercase mb-6">Ціни</h1>
      {items ? <PriceList items={items} /> : <p className="text-danger text-sm">Не вдалося завантажити ціни.</p>}
    </PageLayout>
  );
}
