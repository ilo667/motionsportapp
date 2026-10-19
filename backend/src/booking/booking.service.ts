import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { eq, and, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { bookings, trainingSlots, trainingDays } from '../database/schema';

const KY_ZONE = 'Europe/Kyiv';

@Injectable()
export class BookingService {
  constructor(private readonly database: DatabaseService) {}

  async book(memberId: string, slotId: string) {
    const [slot] = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.id, slotId))
      .limit(1);

    if (!slot) throw new NotFoundException('Slot not found');
    if (slot.status !== 'ACTIVE') throw new ConflictException('Slot is cancelled');

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.id, slot.trainingDayId))
      .limit(1);

    if (!day || day.status !== 'SCHEDULED') throw new ConflictException('Training day is not scheduled');

    this.validateBookingWindow(day.localDate);

    try {
      await this.database.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(trainingSlots)
          .where(eq(trainingSlots.id, slotId))
          .for('update')
          .limit(1);

        if (!locked || locked.status !== 'ACTIVE') throw new ConflictException('Slot is no longer available');
        if (locked.bookedCount >= locked.capacity) throw new ConflictException('Slot is full');

        const [existing] = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(
            and(
              eq(bookings.memberId, memberId),
              eq(bookings.trainingDayId, locked.trainingDayId),
              eq(bookings.status, 'ACTIVE'),
            ),
          )
          .limit(1);

        if (existing) throw new ConflictException('You already have an active booking for this day');

        await tx.insert(bookings).values({
          memberId,
          trainingDayId: locked.trainingDayId,
          slotId,
          status: 'ACTIVE',
        });

        await tx
          .update(trainingSlots)
          .set({ bookedCount: sql`${trainingSlots.bookedCount} + 1` })
          .where(eq(trainingSlots.id, slotId));
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException('You already have an active booking for this day');
      }
      throw err;
    }

    return { ok: true };
  }

  async cancelCurrent(memberId: string) {
    const [booking] = await this.database.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.memberId, memberId), eq(bookings.status, 'ACTIVE')))
      .limit(1);

    if (!booking) throw new NotFoundException('No active booking found');

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.id, booking.trainingDayId))
      .limit(1);

    if (day) this.validateBeforeClose(day.localDate);

    await this.database.db.transaction(async (tx) => {
      await tx
        .update(bookings)
        .set({ status: 'CANCELLED', cancelledAt: new Date() })
        .where(and(eq(bookings.id, booking.id), eq(bookings.status, 'ACTIVE')));

      await tx
        .update(trainingSlots)
        .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - 1, 0)` })
        .where(eq(trainingSlots.id, booking.slotId));
    });

    return { ok: true };
  }

  async switchSlot(memberId: string, newSlotId: string) {
    const [current] = await this.database.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.memberId, memberId), eq(bookings.status, 'ACTIVE')))
      .limit(1);

    if (!current) throw new NotFoundException('No active booking to switch from');
    if (current.slotId === newSlotId) throw new BadRequestException('Already booked on this slot');

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.id, current.trainingDayId))
      .limit(1);

    if (day) this.validateBookingWindow(day.localDate);

    const oldSlotId = current.slotId;
    const [firstId, secondId] = [oldSlotId, newSlotId].sort();

    try {
      await this.database.db.transaction(async (tx) => {
        const [slot1] = await tx
          .select()
          .from(trainingSlots)
          .where(eq(trainingSlots.id, firstId))
          .for('update')
          .limit(1);

        const [slot2] = await tx
          .select()
          .from(trainingSlots)
          .where(eq(trainingSlots.id, secondId))
          .for('update')
          .limit(1);

        if (!slot1 || !slot2) throw new NotFoundException('Slot not found');

        const newSlot = slot1.id === newSlotId ? slot1 : slot2;

        if (newSlot.status !== 'ACTIVE') throw new ConflictException('Target slot is cancelled');
        if (newSlot.bookedCount >= newSlot.capacity) throw new ConflictException('Target slot is full');

        await tx
          .update(bookings)
          .set({ status: 'CANCELLED', cancelledAt: new Date() })
          .where(eq(bookings.id, current.id));

        await tx.insert(bookings).values({
          memberId,
          trainingDayId: current.trainingDayId,
          slotId: newSlotId,
          status: 'ACTIVE',
        });

        await tx
          .update(trainingSlots)
          .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - 1, 0)` })
          .where(eq(trainingSlots.id, oldSlotId));

        await tx
          .update(trainingSlots)
          .set({ bookedCount: sql`${trainingSlots.bookedCount} + 1` })
          .where(eq(trainingSlots.id, newSlotId));
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException('You already have an active booking for this day');
      }
      throw err;
    }

    return { ok: true };
  }

  private validateBookingWindow(localDate: string) {
    const now = DateTime.now().setZone(KY_ZONE);
    const openAt = DateTime.fromISO(`${localDate}T14:00:00`, { zone: KY_ZONE });
    const closeAt = DateTime.fromISO(`${localDate}T21:00:00`, { zone: KY_ZONE });
    if (now < openAt) throw new BadRequestException('Booking opens at 14:00');
    if (now >= closeAt) throw new BadRequestException('Booking window has closed');
  }

  private validateBeforeClose(localDate: string) {
    const now = DateTime.now().setZone(KY_ZONE);
    const closeAt = DateTime.fromISO(`${localDate}T21:00:00`, { zone: KY_ZONE });
    if (now >= closeAt) throw new BadRequestException('Booking window has closed');
  }
}