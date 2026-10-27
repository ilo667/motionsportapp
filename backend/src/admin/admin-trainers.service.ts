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

// «Тренери»: the list of trainers and «Вимкнути»
@Injectable()
export class AdminTrainersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly clock: ClockService,
  ) {}

  // All trainers (reassigning a client, the «Тренери» page): who invited whom, null = added by seed:admin
  // Disabled trainers stay in the list (with who disabled them); the pickers leave them out. Usernames only, never
  // password hashes
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

  // «Вимкнути» on «Тренери»: any trainer disables another one (not themselves, not the first trainer, whose group
  // trainings clients without a trainer see). In one transaction: the trainer can't sign in any more (sessions
  // revoked), their clients and the cash purchases waiting for them move to the chosen trainer, their trainings
  // not over yet (an hour after the start, as the 22:00 cron counts) are cancelled — the days stay, so other
  // trainers' schedules still fill them — and their automatic group trainings are switched off
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
      // Both trainers' rows locked in id order (two disables at once wait for each other, no deadlock), then the
      // chosen one checked again: it may have been disabled since the check above
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
      // Only the member's trainer confirms cash: the new one takes over the requests waiting in the hall
      await tx
        .update(purchases)
        .set({ trainerId: transferToId })
        .where(and(eq(purchases.trainerId, trainerId), eq(purchases.status, 'PENDING'), eq(purchases.method, 'CASH')));
      // Their phones get no trainer pushes any more
      await tx
        .update(adminPushSubscriptions)
        .set({ disabledAt: at })
        .where(and(eq(adminPushSubscriptions.adminId, trainerId), isNull(adminPushSubscriptions.disabledAt)));
      const settings = { bookingOpensAt: schedule.bookingOpensAt, autoCreate: false, updatedAt: at };
      await tx
        .insert(trainerSchedules)
        .values({ trainerId, ...settings })
        .onConflictDoUpdate({ target: trainerSchedules.trainerId, set: settings });

      // Read here, after the above: a training auto-added a moment ago is cancelled too, and the slot rows are
      // locked, so a member booking at this moment waits and then finds the training cancelled (or was booked
      // already and is among those told)
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
