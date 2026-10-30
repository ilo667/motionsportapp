import { and, desc, eq, isNotNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DatabaseService } from '../database/database.service';
import { bookings, cancelRefunds, members, trainingDays, trainingSlots } from '../database/schema';

type Db = DatabaseService['db'];

export type Mark = 'PRESENT' | 'ABSENT' | 'UNMARKED';
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
    // Late-cancellation fee (booking/cancel-fee.ts)
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

// Member's own cancellations and moves; system cancellations have no reason and are excluded
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
