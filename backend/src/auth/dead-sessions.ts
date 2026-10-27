import { lt, or } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { sessions } from '../database/schema';

type Db = DatabaseService['db'];

// A dead session (expired, or ended: logout, password change, a disabled trainer) is kept this long, so a recent
// sign-in or sign-out can still be looked up («мене викинуло»)
const DEAD_SESSIONS_KEPT_DAYS = 30;

// Deletes the sessions dead for longer than that; run on every sign-in, so the table doesn't grow forever.
// A live session is never touched: it hasn't expired and wasn't ended
export async function deleteDeadSessions(db: Db, now: Date) {
  const before = new Date(now.getTime() - DEAD_SESSIONS_KEPT_DAYS * 24 * 60 * 60 * 1000);
  await db.delete(sessions).where(or(lt(sessions.expiresAt, before), lt(sessions.revokedAt, before)));
}
