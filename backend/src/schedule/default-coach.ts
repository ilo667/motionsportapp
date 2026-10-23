import { asc, eq } from 'drizzle-orm';
import { admins, members } from '../database/schema';
import type { DatabaseService } from '../database/database.service';

type Db = DatabaseService['db'];

// Owner of the default Mon/Wed/Fri group slots (created with no coach signed in): the first coach account
export async function getDefaultCoachId(db: Db): Promise<string | null> {
  const [coach] = await db.select({ id: admins.id }).from(admins).orderBy(asc(admins.createdAt)).limit(1);
  return coach?.id ?? null;
}

// Whose group trainings a member sees and books: their coach, or the first coach while they have none
// (also for a visitor who is not signed in)
export async function getMemberCoachId(db: Db, memberId?: string): Promise<string | null> {
  if (memberId) {
    const [member] = await db
      .select({ coachId: members.coachId })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    if (member?.coachId) return member.coachId;
  }
  return getDefaultCoachId(db);
}
