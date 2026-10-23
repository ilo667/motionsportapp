import { eq } from 'drizzle-orm';
import { trainerSchedules, trainerScheduleTimes } from '../database/schema';
import type { DatabaseService } from '../database/database.service';
import { getDefaultTrainerId } from '../schedule/default-trainer';
import { DEFAULT_OPENS_AT, LEGACY_DEFAULT, type TrainerSchedule } from './rules';

type Db = DatabaseService['db'];
type Q = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

// A trainer's schedule as saved on «Мій розклад». Not saved yet: the first trainer keeps the schedule every client
// had before (Mon/Wed/Fri 19:00 and 20:00, booking from 14:00), so nothing changes for them; others have none.
// A plain function (like getMemberTrainerId) so booking, schedule, admin and cron code can share it without a
// module cycle
export async function loadTrainerSchedule(db: Q, trainerId: string): Promise<TrainerSchedule> {
  const [row] = await db
    .select({ bookingOpensAt: trainerSchedules.bookingOpensAt, autoCreate: trainerSchedules.autoCreate })
    .from(trainerSchedules)
    .where(eq(trainerSchedules.trainerId, trainerId))
    .limit(1);
  if (!row) {
    return trainerId === (await getDefaultTrainerId(db))
      ? LEGACY_DEFAULT
      : { bookingOpensAt: DEFAULT_OPENS_AT, autoCreate: false, times: [] };
  }
  const times = await db
    .select({ weekday: trainerScheduleTimes.weekday, slotTime: trainerScheduleTimes.slotTime })
    .from(trainerScheduleTimes)
    .where(eq(trainerScheduleTimes.trainerId, trainerId));
  return {
    ...row,
    times: [...times].sort((a, b) => a.weekday - b.weekday || a.slotTime.localeCompare(b.slotTime)),
  };
}
