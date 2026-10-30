import { eq } from 'drizzle-orm';
import { trainerSchedules, trainerScheduleTimes } from '../database/schema';
import type { DatabaseService } from '../database/database.service';
import { getDefaultTrainerId } from '../schedule/default-trainer';
import { DEFAULT_OPENS_AT, LEGACY_DEFAULT, type TrainerSchedule } from './rules';

type Db = DatabaseService['db'];
type Q = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

// No saved row: LEGACY_DEFAULT for the first trainer, empty for others.
// A plain function so booking, schedule, admin and cron share it without a module cycle
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
