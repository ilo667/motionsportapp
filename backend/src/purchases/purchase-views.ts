import { eq, inArray } from 'drizzle-orm';
import type { DatabaseService } from '../database/database.service';
import { priceItems, purchaseItems, purchases } from '../database/schema';

type Db = DatabaseService['db'];
type Q = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type PurchaseView = {
  id: string;
  method: string;
  status: string;
  totalUah: number;
  createdAt: string;
  lines: { section: string; title: string; optionLabel: string | null; amountUah: number }[];
};

export async function purchaseViews(db: Q, ids: string[]): Promise<PurchaseView[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: purchases.id,
      method: purchases.method,
      status: purchases.status,
      totalUah: purchases.totalUah,
      createdAt: purchases.createdAt,
    })
    .from(purchases)
    .where(inArray(purchases.id, ids));
  const lines = await db
    .select({
      purchaseId: purchaseItems.purchaseId,
      section: priceItems.section,
      title: purchaseItems.title,
      optionLabel: purchaseItems.optionLabel,
      amountUah: purchaseItems.amountUah,
    })
    .from(purchaseItems)
    .innerJoin(priceItems, eq(priceItems.id, purchaseItems.priceItemId))
    .where(inArray(purchaseItems.purchaseId, ids));
  return ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is (typeof rows)[number] => !!r)
    .map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      lines: lines
        .filter((l) => l.purchaseId === r.id)
        .map((l) => ({ section: l.section, title: l.title, optionLabel: l.optionLabel, amountUah: l.amountUah })),
    }));
}
