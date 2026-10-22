import { asc } from 'drizzle-orm';
import { admins } from '../database/schema';
import type { DatabaseService } from '../database/database.service';

// Owner of the default Mon/Wed/Fri group slots (created with no coach signed in): the first coach account
export async function getDefaultCoachId(db: DatabaseService['db']): Promise<string | null> {
  const [coach] = await db.select({ id: admins.id }).from(admins).orderBy(asc(admins.createdAt)).limit(1);
  return coach?.id ?? null;
}
