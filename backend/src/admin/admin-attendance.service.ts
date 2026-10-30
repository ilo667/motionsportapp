import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, inArray, isNotNull, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { trainingSlots, bookings, attendance, bookingGuests, cancelRefunds } from '../database/schema';
import type { UpdateAttendanceDto } from './dto/update-attendance.dto';
import { ClockService } from '../clock/clock.service';
import { EntitlementsService, inLockOrder } from '../purchases/entitlements.service';
import { requireOwnSlot } from '../schedule/default-trainer';
import { apiError } from '../common/api-error';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Attendance marks and late-cancellation fee waivers. A mark spends from a package in the same transaction
@Injectable()
export class AdminAttendanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async markAllAttendance(slotId: string, adminId: string) {
    await requireOwnSlot(this.database.db, adminId, slotId);
    const activeBookings = await this.database.db
      .select({ id: bookings.id, memberId: bookings.memberId })
      .from(bookings)
      .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));

    if (activeBookings.length === 0) return { marked: 0 };

    const now = this.clock.now().toJSDate();
    await this.database.db.transaction(async (tx) => {
      for (const booking of inLockOrder(activeBookings)) {
        await this.saveMark(tx, booking.id, 'PRESENT', now, adminId);
        await this.entitlements.syncSpend(tx, booking.id);
      }
      // Guests too; nothing to spend
      await tx
        .update(bookingGuests)
        .set({ attendance: 'PRESENT', markedAt: now, markedByAdminId: adminId })
        .where(
          and(
            inArray(
              bookingGuests.bookingId,
              activeBookings.map((b) => b.id),
            ),
            eq(bookingGuests.status, 'ACTIVE'),
          ),
        );
    });

    return { marked: activeBookings.length };
  }

  // «Не списувати»: returns the spent training and drops a DUE half refund. Compare-and-set; refused once refunded
  async waiveCancelFee(bookingId: string, adminId: string) {
    const [booking] = await this.database.db
      .select({ id: bookings.id, refundStatus: cancelRefunds.status })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .leftJoin(cancelRefunds, eq(cancelRefunds.bookingId, bookings.id))
      .where(and(eq(bookings.id, bookingId), eq(trainingSlots.trainerId, adminId)))
      .limit(1);
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.refundStatus === 'DONE') throw new ConflictException(apiError('MONEY_RETURNED'));

    await this.database.db.transaction(async (tx) => {
      const [done] = await tx
        .update(bookings)
        .set({ feeWaivedAt: this.clock.now().toJSDate(), feeWaivedBy: adminId })
        .where(
          and(
            eq(bookings.id, bookingId),
            eq(bookings.status, 'CANCELLED'),
            isNotNull(bookings.cancelFee),
            isNull(bookings.feeWaivedAt),
          ),
        )
        .returning({ id: bookings.id });
      if (!done) throw new ConflictException('Nothing to waive');
      const [refund] = await tx
        .update(cancelRefunds)
        .set({ status: 'CANCELLED' })
        .where(and(eq(cancelRefunds.bookingId, bookingId), eq(cancelRefunds.status, 'DUE')))
        .returning({ id: cancelRefunds.id });
      // Refunded meanwhile: keep the fee
      if (!refund && booking.refundStatus === 'DUE') throw new ConflictException(apiError('MONEY_RETURNED'));
      await this.entitlements.syncSpend(tx, bookingId);
    });
    return { ok: true };
  }

  async updateBookingAttendance(bookingId: string, dto: UpdateAttendanceDto, adminId: string) {
    const [booking] = await this.database.db
      .select({ id: bookings.id })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .where(and(eq(bookings.id, bookingId), eq(trainingSlots.trainerId, adminId)))
      .limit(1);

    if (!booking) throw new NotFoundException('Booking not found');

    const now = this.clock.now().toJSDate();
    // Mark and spend move together: a mark spends, unmarking gives it back
    await this.database.db.transaction(async (tx) => {
      if (dto.status === 'UNMARKED') {
        await tx.delete(attendance).where(eq(attendance.bookingId, bookingId));
      } else {
        await this.saveMark(tx, bookingId, dto.status, now, adminId);
      }
      await this.entitlements.syncSpend(tx, bookingId);
    });

    return { ok: true };
  }

  // Caller must syncSpend in the same transaction
  private async saveMark(tx: Tx, bookingId: string, status: 'PRESENT' | 'ABSENT', at: Date, adminId: string) {
    await tx
      .insert(attendance)
      .values({ bookingId, status, markedAt: at, markedByAdminId: adminId })
      .onConflictDoUpdate({ target: attendance.bookingId, set: { status, markedAt: at, markedByAdminId: adminId } });
  }

  // Guest marks are for the count only; nothing is spent
  async updateGuestAttendance(guestId: string, dto: UpdateAttendanceDto, adminId: string) {
    const [guest] = await this.database.db
      .select({ id: bookingGuests.id })
      .from(bookingGuests)
      .innerJoin(bookings, eq(bookings.id, bookingGuests.bookingId))
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .where(and(eq(bookingGuests.id, guestId), eq(trainingSlots.trainerId, adminId)))
      .limit(1);
    if (!guest) throw new NotFoundException('Guest not found');
    const marked = dto.status !== 'UNMARKED';
    await this.database.db
      .update(bookingGuests)
      .set({
        attendance: marked ? dto.status : null,
        markedAt: marked ? this.clock.now().toJSDate() : null,
        markedByAdminId: marked ? adminId : null,
      })
      .where(eq(bookingGuests.id, guestId));
    return { ok: true };
  }
}
