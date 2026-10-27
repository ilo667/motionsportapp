import { and, desc, eq, isNotNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DatabaseService } from '../database/database.service';
import { bookings, cancelRefunds, members, trainingDays, trainingSlots } from '../database/schema';

type Db = DatabaseService['db'];

// What the admin shows in several places: attendance marks, and the cancellations members made themselves
// (today page, history, calendar modal, client page)

export type Mark = 'PRESENT' | 'ABSENT' | 'UNMARKED';
// No attendance row (or a guest's null) = not marked yet
export const markOf = (status: string | null) => (status ?? 'UNMARKED') as Mark;

type CancellationRow = {
  bookingId: string;
  displayName: string;
  reason: string | null;
  cancelledAt: Date | null;
  switchedToTime: string | null;
  cancelFee?: string | null;
  feeWaivedAt?: Date | null;
  refundUah?: number | null;
  refundStatus?: string | null;
};

export function toCancellationView(r: CancellationRow) {
  return {
    bookingId: r.bookingId,
    displayName: r.displayName,
    reason: r.reason ?? '',
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    switchedToTime: r.switchedToTime, // null = cancelled, otherwise moved to that time
    // A late cancellation (booking/cancel-fee.ts): what it cost, half a single training back, and «Не списувати»
    fee: r.cancelFee
      ? {
          kind: r.cancelFee as 'FULL' | 'HALF',
          waived: !!r.feeWaivedAt,
          refundUah: r.refundStatus === 'CANCELLED' ? null : (r.refundUah ?? null),
          refundDone: r.refundStatus === 'DONE',
        }
      : null,
  };
}

// Bookings the member cancelled or moved themselves (they always write a reason). System cancellations
// (the trainer cancelled the training or removed the member, a freeze, cash «Відхилити») have no reason and
// are left out
export function memberCancellations(db: Db, filter: SQL, limit?: number) {
  const target = alias(trainingSlots, 'target_slot');
  const query = db
    .select({
      bookingId: bookings.id,
      slotId: bookings.slotId,
      memberId: bookings.memberId,
      displayName: members.displayName,
      reason: bookings.cancellationReason,
      cancelledAt: bookings.cancelledAt,
      slotTime: trainingSlots.slotTime,
      localDate: trainingDays.localDate,
      switchedToSlotId: bookings.switchedToSlotId,
      switchedToTime: target.slotTime,
      cancelFee: bookings.cancelFee,
      feeWaivedAt: bookings.feeWaivedAt,
      refundUah: cancelRefunds.amountUah,
      refundStatus: cancelRefunds.status,
    })
    .from(bookings)
    .innerJoin(members, eq(members.id, bookings.memberId))
    .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
    .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
    .leftJoin(target, eq(target.id, bookings.switchedToSlotId))
    .leftJoin(cancelRefunds, eq(cancelRefunds.bookingId, bookings.id))
    .where(and(eq(bookings.status, 'CANCELLED'), isNotNull(bookings.cancellationReason), filter))
    .orderBy(desc(bookings.cancelledAt));
  return limit ? query.limit(limit) : query;
}
