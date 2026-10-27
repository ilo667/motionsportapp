import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseService } from '../database/database.service';
import { attendance, bookings, packageSpends, trainingSlots } from '../database/schema';
import type { NotificationService } from '../notifications/notification.service';
import { cancelGuests } from '../booking/group-booking';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// A cancelled training costs nothing: its attendance marks go, and with them the trainings they took from
// packages (activation stays, as with «—»). Called in the transaction that cancels the bookings, before it.
// A member's own late cancellation stays as it was: they cancelled before the trainer did
async function releaseMarks(tx: Tx, slotIds: string[]) {
  if (slotIds.length === 0) return;
  const ofSlots = () =>
    tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(inArray(bookings.slotId, slotIds), eq(bookings.status, 'ACTIVE')));
  await tx.delete(packageSpends).where(inArray(packageSpends.bookingId, ofSlots()));
  await tx.delete(attendance).where(inArray(attendance.bookingId, ofSlots()));
}

// Cancels these slots and every active booking on them (a system cancellation, no reason); their marks and spends
// go back first. The slots are locked before the bookings are read, so a member booking at this moment waits and
// then finds the training cancelled, or was booked already and is among those returned. The caller marks the day
// CANCELLED when it has to, and tells the returned members after the transaction (notifySlotsCancelled)
export async function cancelSlotsTx(
  tx: Tx,
  slotIds: string[],
  at: Date,
): Promise<{ slotId: string; memberId: string }[]> {
  if (slotIds.length === 0) return [];
  await tx.select({ id: trainingSlots.id }).from(trainingSlots).where(inArray(trainingSlots.id, slotIds)).for('update');
  const active = await tx
    .select({ id: bookings.id, slotId: bookings.slotId, memberId: bookings.memberId })
    .from(bookings)
    .where(and(inArray(bookings.slotId, slotIds), eq(bookings.status, 'ACTIVE')));
  await releaseMarks(tx, slotIds);
  await cancelGuests(
    tx,
    active.map((b) => b.id),
    at,
  );
  await tx
    .update(bookings)
    .set({ status: 'CANCELLED', cancelledAt: at })
    .where(and(inArray(bookings.slotId, slotIds), eq(bookings.status, 'ACTIVE')));
  await tx
    .update(trainingSlots)
    .set({ status: 'CANCELLED', bookedCount: 0, cancelledAt: at })
    .where(inArray(trainingSlots.id, slotIds));
  return active.map(({ slotId, memberId }) => ({ slotId, memberId }));
}

// «Тренування скасовано» to the members who were booked (from cancelSlotsTx), one push per training
export async function notifySlotsCancelled(
  notifications: NotificationService,
  slots: { id: string; slotTime: string; localDate: string }[],
  cancelled: { slotId: string; memberId: string }[],
) {
  for (const slot of slots) {
    const memberIds = cancelled.filter((b) => b.slotId === slot.id).map((b) => b.memberId);
    if (memberIds.length === 0) continue;
    await notifications.enqueueAndProcess('SLOT_CANCELLED', `slot-cancelled:${slot.id}:${slot.localDate}`, {
      memberIds,
      slotTime: slot.slotTime,
      localDate: slot.localDate,
    });
  }
}
