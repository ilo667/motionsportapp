import { asc, eq } from 'drizzle-orm';
import { admins, members } from '../database/schema';
import type { DatabaseService } from '../database/database.service';

type Db = DatabaseService['db'];

// Owner of the default Mon/Wed/Fri group slots (created with no trainer signed in): the first trainer account
export async function getDefaultTrainerId(db: Db): Promise<string | null> {
  const [trainer] = await db.select({ id: admins.id }).from(admins).orderBy(asc(admins.createdAt)).limit(1);
  return trainer?.id ?? null;
}

// Whose group trainings a member sees and books: their trainer, or the first trainer while they have none
// (also for a visitor who is not signed in)
export async function getMemberTrainerId(db: Db, memberId?: string): Promise<string | null> {
  if (memberId) {
    const [member] = await db
      .select({ trainerId: members.trainerId })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    if (member?.trainerId) return member.trainerId;
  }
  return getDefaultTrainerId(db);
}
