import { eq } from 'drizzle-orm';
import type { DatabaseService } from '../database/database.service';
import { trainingDays } from '../database/schema';

type Db = DatabaseService['db'];
type Q = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

// Any status
export async function trainingDayOn(db: Q, localDate: string) {
  const [day] = await db.select().from(trainingDays).where(eq(trainingDays.localDate, localDate)).limit(1);
  return day ?? null;
}
