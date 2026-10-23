import 'dotenv/config';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { priceItems } from '../src/database/schema';
import { DEFAULT_PRICE_LIST } from '../src/prices/price-list';

// Adds missing price list rows. Existing rows (and amounts coaches changed) are left alone, so it is safe to rerun
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle({ client: pool });

  const inserted = await db
    .insert(priceItems)
    .values(DEFAULT_PRICE_LIST.map((item, i) => ({ ...item, sortOrder: (i + 1) * 10 })))
    .onConflictDoNothing({ target: priceItems.code })
    .returning({ code: priceItems.code });

  console.log(`Price list: ${inserted.length} added, ${DEFAULT_PRICE_LIST.length - inserted.length} already there.`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
