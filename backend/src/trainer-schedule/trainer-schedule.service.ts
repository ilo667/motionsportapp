import { BadRequestException, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { ScheduleService } from '../schedule/schedule.service';
import { trainerSchedules, trainerScheduleTimes } from '../database/schema';
import { scheduleError, type TrainerSchedule } from './rules';
import { loadTrainerSchedule } from './trainer-schedule.store';

@Injectable()
export class TrainerScheduleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly schedule: ScheduleService,
  ) {}

  get(trainerId: string) {
    return loadTrainerSchedule(this.database.db, trainerId);
  }

  // The whole schedule at once: settings upserted, the week's times replaced
  async save(trainerId: string, schedule: TrainerSchedule) {
    const error = scheduleError(schedule);
    if (error) throw new BadRequestException(error);

    await this.database.db.transaction(async (tx) => {
      const settings = {
        bookingOpensAt: schedule.bookingOpensAt,
        autoCreate: schedule.autoCreate,
        updatedAt: new Date(),
      };
      await tx
        .insert(trainerSchedules)
        .values({ trainerId, ...settings })
        .onConflictDoUpdate({ target: trainerSchedules.trainerId, set: settings });
      await tx.delete(trainerScheduleTimes).where(eq(trainerScheduleTimes.trainerId, trainerId));
      if (schedule.times.length > 0) {
        await tx
          .insert(trainerScheduleTimes)
          .values(schedule.times.map((t) => ({ trainerId, weekday: t.weekday, slotTime: t.slotTime })));
      }
    });
    // The trainer sees the new trainings in the calendar at once, and how many were added or left out
    const created = await this.schedule.ensureGroupSlots(trainerId, { force: true });
    return { ...(await loadTrainerSchedule(this.database.db, trainerId)), ...created };
  }
}
