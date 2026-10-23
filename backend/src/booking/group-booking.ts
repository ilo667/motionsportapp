import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DatabaseService } from '../database/database.service';
import { bookings, members, trainingDays, trainingSlots } from '../database/schema';
import { GROUP_TYPE, KY_ZONE } from '../schedule/training-types';
import { getMemberTrainerId } from '../schedule/default-trainer';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Group bookings are open 14:00–21:00 of the training day
export function groupBookingWindow(localDate: string) {
  return {
    openAt: DateTime.fromISO(`${localDate}T14:00:00`, { zone: KY_ZONE }),
    closeAt: DateTime.fromISO(`${localDate}T21:00:00`, { zone: KY_ZONE }),
  };
}

// The member's active group booking on that day (one per day)
export async function findGroupBooking(db: Db | Tx, memberId: string, trainingDayId: string) {
  const [row] = await db
    .select({
      id: bookings.id,
      slotId: bookings.slotId,
      trainingDayId: trainingSlots.trainingDayId,
      memberId: bookings.memberId,
    })
    .from(bookings)
    .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
    .where(
      and(
        eq(bookings.memberId, memberId),
        eq(trainingSlots.trainingDayId, trainingDayId),
        eq(bookings.status, 'ACTIVE'),
        eq(trainingSlots.trainingType, GROUP_TYPE),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type GroupBookingResult =
  | { ok: true; bookingId: string }
  | { ok: false; reason: 'NOT_FOUND' | 'CANCELLED' | 'NOT_SCHEDULED' | 'WINDOW' | 'FULL' | 'ALREADY_BOOKED' };

// Books a group training inside a transaction that must not fail because of it (a payment being confirmed, a cash
// purchase): every rule is checked before the insert, so no unique violation can abort the caller's transaction.
// Same rules as BookingService.book, except the group pass (the caller is the one paying for it)
export async function tryBookGroup(
  tx: Tx,
  now: DateTime,
  memberId: string,
  slotId: string,
): Promise<GroupBookingResult> {
  // Member row first, like BookingService: one group booking per member per day
  await tx.select({ id: members.id }).from(members).where(eq(members.id, memberId)).for('update').limit(1);
  const [slot] = await tx
    .select({
      id: trainingSlots.id,
      status: trainingSlots.status,
      trainingType: trainingSlots.trainingType,
      capacity: trainingSlots.capacity,
      bookedCount: trainingSlots.bookedCount,
      trainerId: trainingSlots.trainerId,
      trainingDayId: trainingSlots.trainingDayId,
      localDate: trainingDays.localDate,
      dayStatus: trainingDays.status,
    })
    .from(trainingSlots)
    .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
    .where(eq(trainingSlots.id, slotId))
    .for('update', { of: trainingSlots })
    .limit(1);
  const trainerId = await getMemberTrainerId(tx, memberId);

  if (!slot || slot.trainingType !== GROUP_TYPE || slot.trainerId !== trainerId)
    return { ok: false, reason: 'NOT_FOUND' };
  if (slot.status !== 'ACTIVE') return { ok: false, reason: 'CANCELLED' };
  if (slot.dayStatus !== 'SCHEDULED') return { ok: false, reason: 'NOT_SCHEDULED' };
  const { openAt, closeAt } = groupBookingWindow(slot.localDate);
  if (now < openAt || now >= closeAt) return { ok: false, reason: 'WINDOW' };
  if (slot.bookedCount >= slot.capacity) return { ok: false, reason: 'FULL' };
  if (await findGroupBooking(tx, memberId, slot.trainingDayId)) return { ok: false, reason: 'ALREADY_BOOKED' };

  const [booking] = await tx
    .insert(bookings)
    .values({ memberId, slotId, status: 'ACTIVE' })
    .returning({ id: bookings.id });
  await tx
    .update(trainingSlots)
    .set({ bookedCount: sql`${trainingSlots.bookedCount} + 1` })
    .where(eq(trainingSlots.id, slotId));
  return { ok: true, bookingId: booking.id };
}
