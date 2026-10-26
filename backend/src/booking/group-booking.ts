import { and, eq, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { DatabaseService } from '../database/database.service';
import { bookingGuests, bookings, members, trainingDays, trainingSlots, vacancyAlerts } from '../database/schema';
import { GROUP_TYPE, slotStartsAt } from '../schedule/training-types';
import { bookingOpensAt } from '../trainer-schedule/rules';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';
import { getMemberTrainerId } from '../schedule/default-trainer';
import { memberFrozenOn } from '../freezes/freeze.store';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// A group booking opens on the training day at the trainer's time («Мій розклад») and closes when the training
// starts; cancelling and switching also end at the start
export function groupBookingWindow(localDate: string, slotTime: string, opensAt: string) {
  return { openAt: bookingOpensAt(localDate, opensAt), closeAt: slotStartsAt(localDate, slotTime) };
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
  | {
      ok: false;
      reason: 'NOT_FOUND' | 'CANCELLED' | 'NOT_SCHEDULED' | 'WINDOW' | 'FULL' | 'ALREADY_BOOKED' | 'FROZEN';
    };

// Books a group training inside a transaction that must not fail because of it (a payment being confirmed, a cash
// purchase): every rule is checked before the insert, so no unique violation can abort the caller's transaction.
// Same rules as BookingService.book (the freeze too), except the group pass (the caller is the one paying for it)
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
      slotTime: trainingSlots.slotTime,
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
  const { bookingOpensAt: opensAt } = await loadTrainerSchedule(tx, slot.trainerId);
  const { openAt, closeAt } = groupBookingWindow(slot.localDate, slot.slotTime, opensAt);
  if (now < openAt || now >= closeAt) return { ok: false, reason: 'WINDOW' };
  if (slot.bookedCount >= slot.capacity) return { ok: false, reason: 'FULL' };
  if (await findGroupBooking(tx, memberId, slot.trainingDayId)) return { ok: false, reason: 'ALREADY_BOOKED' };
  if (await memberFrozenOn(tx, memberId, slot.localDate)) return { ok: false, reason: 'FROZEN' };

  const [booking] = await tx
    .insert(bookings)
    .values({ memberId, slotId, status: 'ACTIVE' })
    .returning({ id: bookings.id });
  await tx
    .update(trainingSlots)
    .set({ bookedCount: sql`${trainingSlots.bookedCount} + 1` })
    .where(eq(trainingSlots.id, slotId));
  // They hold a seat now: no «З'явилось місце» for this slot (BookingService.book does the same)
  await tx
    .update(vacancyAlerts)
    .set({ active: false })
    .where(and(eq(vacancyAlerts.memberId, memberId), eq(vacancyAlerts.slotId, slotId)));
  return { ok: true, bookingId: booking.id };
}

// A booking that goes takes its guest along: cancels the active guests of these bookings and returns the ids of
// the bookings that had one, so the caller frees one more seat for each (training_slots.booked_count)
export async function cancelGuests(tx: Tx, bookingIds: string[], at: Date): Promise<Set<string>> {
  if (bookingIds.length === 0) return new Set();
  const rows = await tx
    .update(bookingGuests)
    .set({ status: 'CANCELLED', cancelledAt: at })
    .where(and(inArray(bookingGuests.bookingId, bookingIds), eq(bookingGuests.status, 'ACTIVE')))
    .returning({ bookingId: bookingGuests.bookingId });
  return new Set(rows.map((r) => r.bookingId));
}
