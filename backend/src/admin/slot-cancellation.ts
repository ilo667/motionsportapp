import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseService } from '../database/database.service';
import { attendance, bookings, packageSpends, trainingSlots } from '../database/schema';
import type { NotificationService } from '../notifications/notification.service';
import { cancelGuests } from '../booking/group-booking';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// A cancelled training costs nothing: delete marks and spends of active bookings (activation stays).
// Must run before the bookings are cancelled. Member late cancellations are untouched
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

// Slots are locked before bookings are read, so a concurrent booking either waits and sees the slot cancelled
// or is in the result. Caller handles the day status and calls notifySlotsCancelled after commit
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

// One push per training to the members returned by cancelSlotsTx
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
