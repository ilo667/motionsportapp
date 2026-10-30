import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { PriceListItem } from "@/lib/api";
import { PageLayout } from "@/components/ui/PageLayout";
import { PriceList } from "@/components/prices/PriceList";

// Server-side: no /api rewrite here, so call BACKEND_URL and pass on the `session` cookie only
async function getPrices(session: string): Promise<PriceListItem[] | "signed-out" | "trainer" | null> {
  try {
    const res = await fetch(`${process.env.BACKEND_URL ?? "http://localhost:3001"}/prices`, {
      headers: { Cookie: `session=${session}` },
      cache: "no-store",
    });
    if (res.status === 401) return "signed-out";
    if (res.status === 403) return "trainer";
    return res.ok ? ((await res.json()) as PriceListItem[]) : null;
  } catch {
    return null;
  }
}

// Rendered per request, so always current. Visitors go to /login, trainers to /admin
export default async function PricesPage() {
  const session = (await cookies()).get("session")?.value;
  const items = session ? await getPrices(session) : "signed-out";
  if (items === "signed-out") redirect("/login");
  if (items === "trainer") redirect("/admin");

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
