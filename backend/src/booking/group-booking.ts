import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
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

// Opens on the training day at the trainer's booking_opens_at, closes at the start (so do cancel and switch)
export function groupBookingWindow(localDate: string, slotTime: string, opensAt: string) {
  return { openAt: bookingOpensAt(localDate, opensAt), closeAt: slotStartsAt(localDate, slotTime) };
}

export async function findGroupBooking(db: Db | Tx, memberId: string, trainingDayId: string) {
  const [row] = await db
    .select({
      id: bookings.id,
      slotId: bookings.slotId,
      trainingDayId: trainingSlots.trainingDayId,
      memberId: bookings.memberId,
      slotTime: trainingSlots.slotTime,
      trainerId: trainingSlots.trainerId,
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

// Slots cancelled late with an unwaived fee: booking one again would spend it twice
export async function lateCancelledSlotIds(db: Db | Tx, memberId: string, slotIds: string[]): Promise<Set<string>> {
  if (slotIds.length === 0) return new Set();
  const rows = await db
    .select({ slotId: bookings.slotId })
    .from(bookings)
    .where(
      and(
        eq(bookings.memberId, memberId),
        inArray(bookings.slotId, slotIds),
        eq(bookings.status, 'CANCELLED'),
        isNotNull(bookings.cancelFee),
        isNull(bookings.feeWaivedAt),
      ),
    );
  return new Set(rows.map((r) => r.slotId));
}

export type GroupBookingResult =
  | { ok: true; bookingId: string }
  | {
      ok: false;
      reason:
        | 'NOT_FOUND'
        | 'CANCELLED'
        | 'NOT_SCHEDULED'
        | 'WINDOW'
        | 'FULL'
        | 'ALREADY_BOOKED'
        | 'FROZEN'
        | 'LATE_CANCELLED';
    };

// Serializes one member's bookings, purchases and freezes, so concurrent requests can't both pass a
// one-per-day, one-open-purchase or freeze check. null = unknown member
export async function lockMember(tx: Tx, memberId: string) {
  const [member] = await tx
    .select({ trainerId: members.trainerId, displayName: members.displayName })
    .from(members)
    .where(eq(members.id, memberId))
    .for('update')
    .limit(1);
  return member ?? null;
}

// Books inside a caller's transaction (payment, cash purchase) without throwing: every rule is checked before
// the insert, since a unique violation would abort that transaction. Keep in step with BookingService.book
// (minus the group pass check: the caller is paying for it)
export async function tryBookGroup(
  tx: Tx,
  now: DateTime,
  memberId: string,
  slotId: string,
): Promise<GroupBookingResult> {
  // Member row before slot row: same lock order as BookingService
  await lockMember(tx, memberId);
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
  if ((await lateCancelledSlotIds(tx, memberId, [slotId])).size > 0) return { ok: false, reason: 'LATE_CANCELLED' };

  const [booking] = await tx
    .insert(bookings)
    .values({ memberId, slotId, status: 'ACTIVE' })
    .returning({ id: bookings.id });
  await takeSeats(tx, slotId, 1);
  // Any booking turns the member's vacancy alert off, as in BookingService.book
  await tx
    .update(vacancyAlerts)
    .set({ active: false })
    .where(and(eq(vacancyAlerts.memberId, memberId), eq(vacancyAlerts.slotId, slotId)));
  return { ok: true, bookingId: booking.id };
}

// Returns the bookings that had a guest, so the caller frees one more seat for each
export async function cancelGuests(tx: Tx, bookingIds: string[], at: Date): Promise<Set<string>> {
  if (bookingIds.length === 0) return new Set();
  const rows = await tx
    .update(bookingGuests)
    .set({ status: 'CANCELLED', cancelledAt: at })
    .where(and(inArray(bookingGuests.bookingId, bookingIds), eq(bookingGuests.status, 'ACTIVE')))
    .returning({ bookingId: bookingGuests.bookingId });
  return new Set(rows.map((r) => r.bookingId));
}

// Caller holds the slot row lock and has checked capacity
export async function takeSeats(tx: Tx, slotId: string, seats: number) {
  await tx
    .update(trainingSlots)
    .set({ bookedCount: sql`${trainingSlots.bookedCount} + ${seats}` })
    .where(eq(trainingSlots.id, slotId));
}

// Under the slot row lock. true = a full group slot: the caller sends vacancy pushes after the transaction
export async function freeSeats(tx: Tx, slotId: string, seats: number): Promise<boolean> {
  const [slot] = await tx
    .select({
      bookedCount: trainingSlots.bookedCount,
      capacity: trainingSlots.capacity,
      trainingType: trainingSlots.trainingType,
    })
    .from(trainingSlots)
    .where(eq(trainingSlots.id, slotId))
    .for('update')
    .limit(1);
  await tx
    .update(trainingSlots)
    .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - ${seats}, 0)` })
    .where(eq(trainingSlots.id, slotId));
  return !!slot && slot.trainingType === GROUP_TYPE && slot.bookedCount >= slot.capacity;
}
