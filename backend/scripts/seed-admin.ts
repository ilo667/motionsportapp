import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { eq } from 'drizzle-orm';
import { admins } from '../src/database/schema';

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    console.error('Error: set ADMIN_USERNAME and ADMIN_PASSWORD in backend/.env');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle({ client: pool });

  const passwordHash = await bcrypt.hash(password, 12);

  const [existing] = await db
    .select()
    .from(admins)
    .where(eq(admins.username, username))
    .limit(1);

  if (existing) {
    await db.update(admins).set({ passwordHash }).where(eq(admins.id, existing.id));
    console.log(`Admin "${username}" password updated.`);
  } else {
    await db.insert(admins).values({ username, passwordHash });
    console.log(`Admin "${username}" created.`);
  }

  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});