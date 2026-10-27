import { isNotNull, lt, or } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { sessions } from '../database/schema';

type Db = DatabaseService['db'];

// Sessions that can't sign anyone in any more: expired, or ended (logout, password change, a disabled trainer).
// Nothing reads them (a cookie only finds a live session), so they are deleted on every sign-in instead of piling up
export async function deleteDeadSessions(db: Db, now: Date) {
  await db.delete(sessions).where(or(lt(sessions.expiresAt, now), isNotNull(sessions.revokedAt)));
}
