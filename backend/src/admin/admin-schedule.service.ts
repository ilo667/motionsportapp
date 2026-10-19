import { Injectable, NotFoundException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { trainingDays, trainingSlots, bookings } from '../database/schema';
import type { UpsertTrainingDayDto } from './dto/upsert-training-day.dto';
import type { UpdateSlotDto } from './dto/update-slot.dto';

const SLOT_TIMES = ['19:00', '20:00'];

@Injectable()
export class AdminScheduleService {
  constructor(private readonly database: DatabaseService) {}

  async upsertTrainingDay(date: string, dto: UpsertTrainingDayDto) {
    await this.database.db
      .insert(trainingDays)
      .values({
        localDate: date,
        status: dto.status,
        isException: dto.isException ?? false,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: trainingDays.localDate,
        set: { status: dto.status, isException: dto.isException ?? false, updatedAt: new Date() },
      });

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.localDate, date))
      .limit(1);

    if (!day) throw new NotFoundException('Training day not found after upsert');

    if (dto.status === 'SCHEDULED') {
      const slotValues = SLOT_TIMES.map((slotTime) => ({
        trainingDayId: day.id,
        slotTime,
        status: 'ACTIVE' as const,
        capacity: 8,
        bookedCount: 0,
      }));
      await this.database.db.insert(trainingSlots).values(slotValues).onConflictDoNothing();
    }

    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.trainingDayId, day.id))
      .orderBy(trainingSlots.slotTime);

    return { ...day, slots };
  }

  async updateSlot(slotId: string, dto: UpdateSlotDto) {
    const [slot] = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.id, slotId))
      .limit(1);

    if (!slot) throw new NotFoundException('Slot not found');

    if (dto.status === 'CANCELLED' && slot.status === 'ACTIVE') {
      await this.database.db.transaction(async (tx) => {
        await tx
          .update(bookings)
          .set({ status: 'CANCELLED', cancelledAt: new Date() })
          .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));

        await tx
          .update(trainingSlots)
          .set({ status: 'CANCELLED', bookedCount: 0, cancelledAt: new Date() })
          .where(eq(trainingSlots.id, slotId));
      });
    } else {
      await this.database.db
        .update(trainingSlots)
        .set({ status: dto.status, ...(dto.status === 'ACTIVE' ? { cancelledAt: null } : {}) })
        .where(eq(trainingSlots.id, slotId));
    }

    const [updated] = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.id, slotId))
      .limit(1);

    return updated;
  }
}