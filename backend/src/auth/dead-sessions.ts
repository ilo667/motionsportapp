import { lt, or } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { sessions } from '../database/schema';

type Db = DatabaseService['db'];

// Expired or revoked sessions are kept this long, so a recent sign-in / sign-out can be looked up
const DEAD_SESSIONS_KEPT_DAYS = 30;

// Runs on every sign-in so the table doesn't grow forever
export async function deleteDeadSessions(db: Db, now: Date) {
  const before = new Date(now.getTime() - DEAD_SESSIONS_KEPT_DAYS * 24 * 60 * 60 * 1000);
  await db.delete(sessions).where(or(lt(sessions.expiresAt, before), lt(sessions.revokedAt, before)));
}
