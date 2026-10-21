import { Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, inArray, gte, lte, sum } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DatabaseService } from '../database/database.service';
import { trainingDays, trainingSlots, bookings, members, attendance } from '../database/schema';
import type { UpsertTrainingDayDto } from './dto/upsert-training-day.dto';
import type { UpdateSlotDto } from './dto/update-slot.dto';
import type { UpdateAttendanceDto } from './dto/update-attendance.dto';
import { NotificationService } from '../notifications/notification.service';
import { DemoService } from '../demo/demo.service';

const SLOT_TIMES = ['19:00', '20:00'];
const KY_ZONE = 'Europe/Kyiv';

@Injectable()
export class AdminScheduleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly demoService: DemoService,
  ) {}

  async getSchedule() {
    const now = await this.demoService.getNow();
    const today = now.toISODate()!;

    const upcoming = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.status, 'SCHEDULED'))
      .orderBy(trainingDays.localDate)
      .limit(30);

    const future = upcoming.filter((d) => d.localDate >= today);
    let targetDay = future.find((day) => {
      const closeAt = DateTime.fromISO(`${day.localDate}T21:00:00`, { zone: KY_ZONE });
      return now < closeAt;
    }) ?? future[0];

    if (!targetDay) return null;

    const openAt = DateTime.fromISO(`${targetDay.localDate}T14:00:00`, { zone: KY_ZONE });
    const closeAt = DateTime.fromISO(`${targetDay.localDate}T21:00:00`, { zone: KY_ZONE });
    const bookingWindowOpen = now >= openAt && now < closeAt;

    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.trainingDayId, targetDay.id))
      .orderBy(trainingSlots.slotTime);

    const slotIds = slots.map((s) => s.id);

    const participantRows =
      slotIds.length > 0
        ? await this.database.db
            .select({
              bookingId: bookings.id,
              slotId: bookings.slotId,
              displayName: members.displayName,
              attendanceStatus: attendance.status,
            })
            .from(bookings)
            .innerJoin(members, eq(bookings.memberId, members.id))
            .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
            .where(and(inArray(bookings.slotId, slotIds), eq(bookings.status, 'ACTIVE')))
            .orderBy(bookings.createdAt)
        : [];

    return {
      localDate: targetDay.localDate,
      status: targetDay.status,
      bookingWindowOpen,
      bookingOpenAt: openAt.toUTC().toISO(),
      bookingCloseAt: closeAt.toUTC().toISO(),
      serverTime: now.toUTC().toISO(),
      isDemoMode: this.demoService.isDemoMode(),
      slots: slots.map((s) => {
        const participants = participantRows
          .filter((p) => p.slotId === s.id)
          .map((p) => ({
            bookingId: p.bookingId,
            displayName: p.displayName,
            attendanceStatus: (p.attendanceStatus ?? 'UNMARKED') as 'PRESENT' | 'ABSENT' | 'UNMARKED',
          }));
        return {
          id: s.id,
          slotTime: s.slotTime,
          status: s.status,
          capacity: s.capacity,
          bookedCount: s.bookedCount,
          participants,
        };
      }),
    };
  }

  async getCalendar(month: string) {
    // month = '2026-10'
    const start = `${month}-01`;
    const [year, m] = month.split('-').map(Number);
    const lastDay = new Date(year, m, 0).getDate();
    const end = `${month}-${String(lastDay).padStart(2, '0')}`;

    const days = await this.database.db
      .select({
        id: trainingDays.id,
        localDate: trainingDays.localDate,
        status: trainingDays.status,
        trainingType: trainingDays.trainingType,
        isException: trainingDays.isException,
      })
      .from(trainingDays)
      .where(and(gte(trainingDays.localDate, start), lte(trainingDays.localDate, end)));

    if (days.length === 0) return [];

    const dayIds = days.map((d) => d.id);
    const slotTotals = await this.database.db
      .select({
        trainingDayId: trainingSlots.trainingDayId,
        bookedCount: sum(trainingSlots.bookedCount).mapWith(Number),
        totalCapacity: sum(trainingSlots.capacity).mapWith(Number),
      })
      .from(trainingSlots)
      .where(inArray(trainingSlots.trainingDayId, dayIds))
      .groupBy(trainingSlots.trainingDayId);

    const totalsMap = Object.fromEntries(
      slotTotals.map((s) => [s.trainingDayId, { bookedCount: s.bookedCount ?? 0, totalCapacity: s.totalCapacity ?? 0 }]),
    );

    return days.map((d) => ({
      localDate: d.localDate,
      status: d.status,
      trainingType: d.trainingType,
      isException: d.isException,
      bookedCount: totalsMap[d.id]?.bookedCount ?? 0,
      totalCapacity: totalsMap[d.id]?.totalCapacity ?? 0,
    }));
  }

  async upsertTrainingDay(date: string, dto: UpsertTrainingDayDto) {
    await this.database.db
      .insert(trainingDays)
      .values({
        localDate: date,
        status: dto.status,
        trainingType: dto.trainingType ?? 'групові',
        isException: dto.isException ?? false,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: trainingDays.localDate,
        set: {
          status: dto.status,
          trainingType: dto.trainingType ?? 'групові',
          isException: dto.isException ?? false,
          updatedAt: new Date(),
        },
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

    if (dto.status === 'CANCELLED') {
      const daySlots = await this.database.db
        .select({ id: trainingSlots.id, slotTime: trainingSlots.slotTime })
        .from(trainingSlots)
        .where(eq(trainingSlots.trainingDayId, day.id));

      if (daySlots.length > 0) {
        const daySlotIds = daySlots.map((s) => s.id);

        const affectedBookings = await this.database.db
          .select({ memberId: bookings.memberId, slotId: bookings.slotId })
          .from(bookings)
          .where(and(inArray(bookings.slotId, daySlotIds), eq(bookings.status, 'ACTIVE')));

        await this.database.db.transaction(async (tx) => {
          await tx
            .update(bookings)
            .set({ status: 'CANCELLED', cancelledAt: new Date() })
            .where(and(inArray(bookings.slotId, daySlotIds), eq(bookings.status, 'ACTIVE')));

          await tx
            .update(trainingSlots)
            .set({ status: 'CANCELLED', bookedCount: 0, cancelledAt: new Date() })
            .where(inArray(trainingSlots.id, daySlotIds));
        });

        for (const slot of daySlots) {
          const memberIds = affectedBookings
            .filter((b) => b.slotId === slot.id)
            .map((b) => b.memberId);
          if (memberIds.length > 0) {
            await this.notifications.enqueueAndProcess('SLOT_CANCELLED', `slot-cancelled:${slot.id}:${date}`, {
              memberIds,
              slotTime: slot.slotTime,
              localDate: date,
            });
          }
        }
      }
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
      const affectedBookings = await this.database.db
        .select({ memberId: bookings.memberId })
        .from(bookings)
        .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));

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

      const memberIds = affectedBookings.map((b) => b.memberId);
      if (memberIds.length > 0) {
        const [day] = await this.database.db
          .select({ localDate: trainingDays.localDate })
          .from(trainingDays)
          .where(eq(trainingDays.id, slot.trainingDayId))
          .limit(1);
        if (day) {
          await this.notifications.enqueueAndProcess('SLOT_CANCELLED', `slot-cancelled:${slotId}:${day.localDate}`, {
            memberIds,
            slotTime: slot.slotTime,
            localDate: day.localDate,
          });
        }
      }
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

  async markAllAttendance(slotId: string, adminId: string) {
    const activeBookings = await this.database.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));

    if (activeBookings.length === 0) return { marked: 0 };

    const now = new Date();
    await this.database.db.transaction(async (tx) => {
      for (const booking of activeBookings) {
        await tx
          .insert(attendance)
          .values({ bookingId: booking.id, status: 'PRESENT', markedAt: now, markedByAdminId: adminId })
          .onConflictDoUpdate({
            target: attendance.bookingId,
            set: { status: 'PRESENT', markedAt: now, markedByAdminId: adminId },
          });
      }
    });

    return { marked: activeBookings.length };
  }

  async updateBookingAttendance(bookingId: string, dto: UpdateAttendanceDto, adminId: string) {
    const [booking] = await this.database.db
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .limit(1);

    if (!booking) throw new NotFoundException('Booking not found');

    const now = new Date();
    if (dto.status === 'UNMARKED') {
      await this.database.db.delete(attendance).where(eq(attendance.bookingId, bookingId));
    } else {
      await this.database.db
        .insert(attendance)
        .values({ bookingId, status: dto.status, markedAt: now, markedByAdminId: adminId })
        .onConflictDoUpdate({
          target: attendance.bookingId,
          set: { status: dto.status, markedAt: now, markedByAdminId: adminId },
        });
    }

    return { ok: true };
  }
}