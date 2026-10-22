import { asc } from 'drizzle-orm';
import { admins } from '../database/schema';
import type { DatabaseService } from '../database/database.service';

// Owner of demo scenario slots (no coach is signed in there): the first coach account (today "admin").
// Real trainings are always created by a coach in the calendar
export async function getDefaultCoachId(db: DatabaseService['db']): Promise<string | null> {
  const [coach] = await db.select({ id: admins.id }).from(admins).orderBy(asc(admins.createdAt)).limit(1);
  return coach?.id ?? null;
}
