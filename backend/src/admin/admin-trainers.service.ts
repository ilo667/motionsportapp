import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { eq, and, inArray, gte, asc, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DatabaseService } from '../database/database.service';
import {
  trainingDays,
  trainingSlots,
  members,
  admins,
  sessions,
  purchases,
  trainerSchedules,
  adminPushSubscriptions,
} from '../database/schema';
import { NotificationService } from '../notifications/notification.service';
import { ClockService } from '../clock/clock.service';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';
import { enabledTrainer, getDefaultTrainerId } from '../schedule/default-trainer';
import { slotOverAt } from '../schedule/training-types';
import { cancelSlotsTx, notifySlotsCancelled } from './slot-cancellation';

@Injectable()
export class AdminTrainersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly clock: ClockService,
  ) {}

  // Includes disabled trainers (pickers filter them). invitedBy null = seed:admin. Never select password hashes
  async getTrainers() {
    const inviter = alias(admins, 'inviter');
    const disabler = alias(admins, 'disabler');
    return this.database.db
      .select({
        id: admins.id,
        username: admins.username,
        createdAt: admins.createdAt,
        invitedBy: inviter.username,
        disabledAt: admins.disabledAt,
        disabledBy: disabler.username,
      })
      .from(admins)
      .leftJoin(inviter, eq(inviter.id, admins.invitedByAdminId))
      .leftJoin(disabler, eq(disabler.id, admins.disabledByAdminId))
      .orderBy(asc(admins.username));
  }

  // One transaction: revoke sessions and pushes, move clients and pending cash purchases, cancel trainings not
  // over yet, turn off auto-creation. Not self, not the first trainer (unassigned members see their groups).
  // Days are not marked CANCELLED: other trainers still use them
  async disableTrainer(adminId: string, trainerId: string, transferToId: string) {
    if (trainerId === adminId) throw new BadRequestException('Cannot disable yourself');
    if (trainerId === (await getDefaultTrainerId(this.database.db)))
      throw new BadRequestException('Cannot disable the first trainer');
    if (transferToId === trainerId) throw new BadRequestException('Cannot transfer to the same trainer');

    if (!(await enabledTrainer(this.database.db, transferToId))) throw new NotFoundException('Trainer not found');
    const [trainer] = await this.database.db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.id, trainerId))
      .limit(1);
    if (!trainer) throw new NotFoundException('Trainer not found');

    const now = this.clock.now();
    const schedule = await loadTrainerSchedule(this.database.db, trainerId);

    const { movedClients, toCancel, affected } = await this.database.db.transaction(async (tx) => {
      const at = now.toJSDate();
      // Lock both rows in id order (no deadlock), then recheck the target: it may have been disabled meanwhile
      const locked = await tx
        .select({ id: admins.id, disabledAt: admins.disabledAt })
        .from(admins)
        .where(inArray(admins.id, [trainerId, transferToId]))
        .orderBy(asc(admins.id))
        .for('update');
      if (!locked.some((a) => a.id === transferToId && !a.disabledAt)) throw new NotFoundException('Trainer not found');
      const [disabled] = await tx
        .update(admins)
        .set({ disabledAt: at, disabledByAdminId: adminId })
        .where(and(eq(admins.id, trainerId), isNull(admins.disabledAt)))
        .returning({ id: admins.id });
      if (!disabled) throw new ConflictException('Trainer already disabled');

      await tx
        .update(sessions)
        .set({ revokedAt: at })
        .where(
          and(eq(sessions.principalType, 'admin'), eq(sessions.principalId, trainerId), isNull(sessions.revokedAt)),
        );
      const moved = await tx
        .update(members)
        .set({ trainerId: transferToId })
        .where(eq(members.trainerId, trainerId))
        .returning({ id: members.id });
      // Only the member's trainer confirms cash
      await tx
        .update(purchases)
        .set({ trainerId: transferToId })
        .where(and(eq(purchases.trainerId, trainerId), eq(purchases.status, 'PENDING'), eq(purchases.method, 'CASH')));
      await tx
        .update(adminPushSubscriptions)
        .set({ disabledAt: at })
        .where(and(eq(adminPushSubscriptions.adminId, trainerId), isNull(adminPushSubscriptions.disabledAt)));
      const settings = { bookingOpensAt: schedule.bookingOpensAt, autoCreate: false, updatedAt: at };
      await tx
        .insert(trainerSchedules)
        .values({ trainerId, ...settings })
        .onConflictDoUpdate({ target: trainerSchedules.trainerId, set: settings });

      // Read and lock here, last: catches a just-auto-added slot, and a concurrent booking waits, then sees it
      // cancelled (or is already among those notified)
      const fromToday = await tx
        .select({ id: trainingSlots.id, localDate: trainingDays.localDate, slotTime: trainingSlots.slotTime })
        .from(trainingSlots)
        .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
        .where(
          and(
            eq(trainingSlots.trainerId, trainerId),
            eq(trainingSlots.status, 'ACTIVE'),
            gte(trainingDays.localDate, now.toISODate()!),
          ),
        )
        .for('update', { of: trainingSlots });
      const slots = fromToday.filter((s) => slotOverAt(s.localDate, s.slotTime) > now);
      const affected = await cancelSlotsTx(
        tx,
        slots.map((s) => s.id),
        at,
      );
      return { movedClients: moved.length, toCancel: slots, affected };
    });

    await notifySlotsCancelled(this.notifications, toCancel, affected);

    return { movedClients, cancelledTrainings: toCancel.length };
  }
}
