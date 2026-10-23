import 'dotenv/config';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { priceItems } from '../src/database/schema';
import { DEFAULT_PRICE_LIST } from '../src/prices/price-list';

// Adds missing price list rows and refreshes the others' metadata. Amounts trainers changed are kept, so it is safe to rerun
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle({ client: pool });

  // Existing rows get the list's names, order and what they give; amounts are never touched
  const rows = await db
    .insert(priceItems)
    .values(DEFAULT_PRICE_LIST.map((item, i) => ({ ...item, sortOrder: (i + 1) * 10 })))
    .onConflictDoUpdate({
      target: priceItems.code,
      set: {
        section: sql`excluded.section`,
        title: sql`excluded.title`,
        optionLabel: sql`excluded.option_label`,
        sortOrder: sql`excluded.sort_order`,
        durationMonths: sql`excluded.duration_months`,
        trainingType: sql`excluded.training_type`,
        trainingCount: sql`excluded.training_count`,
      },
    })
    // xmax = 0 only for a freshly inserted row
    .returning({ inserted: sql<boolean>`(xmax = 0)` });

  const added = rows.filter((r) => r.inserted).length;
  console.log(`Price list: ${added} added, ${rows.length - added} updated.`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
