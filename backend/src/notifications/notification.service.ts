import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { notificationEvents } from '../database/schema';
import { PushService, PushPayload } from './push.service';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { VacancyAlertsService } from './vacancy-alerts.service';

const ICON = '/motion-gym-logo-app.png';

type EventType =
  | 'BOOKING_OPEN'
  | 'SLOT_CANCELLED'
  | 'VACANCY'
  | 'MEMBER_CANCELLED'
  | 'CASH_REQUESTED'
  | 'FREEZE_REQUESTED'
  | 'FREEZE_DECIDED';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly push: PushService,
    private readonly subs: PushSubscriptionsService,
    private readonly vacancyAlerts: VacancyAlertsService,
  ) {}

  // Never throws: a failed push never fails the request that sent it (the member's cancel, the trainer's «Відхилити»…)
  async enqueueAndProcess(eventType: EventType, dedupeKey: string, payload: Record<string, unknown>) {
    try {
      const inserted = await this.database.db
        .insert(notificationEvents)
        .values({ eventType, dedupeKey, payload, status: 'PENDING' })
        .onConflictDoNothing()
        .returning({ id: notificationEvents.id });

      if (inserted.length === 0) return; // already sent

      const [event] = await this.database.db
        .select()
        .from(notificationEvents)
        .where(eq(notificationEvents.id, inserted[0].id))
        .limit(1);

      if (event) await this.processEvent(event);
    } catch (err) {
      this.logger.error(`Push ${dedupeKey} failed`, err);
    }
  }

  // Sent once, right away. A failed event stays FAILED (logged); there are no retries (push delivery isn't
  // guaranteed anyway, and a retry could re-send to those who already got it)
  private async processEvent(event: typeof notificationEvents.$inferSelect) {
    try {
      const p = event.payload as Record<string, unknown>;
      if (event.eventType === 'BOOKING_OPEN') await this.sendOpening(p);
      else if (event.eventType === 'SLOT_CANCELLED') await this.sendCancellation(p);
      else if (event.eventType === 'VACANCY') await this.sendVacancy(p);
      else if (event.eventType === 'MEMBER_CANCELLED') await this.sendMemberCancelled(p);
      else if (event.eventType === 'CASH_REQUESTED') await this.sendCashRequested(p);
      else if (event.eventType === 'FREEZE_REQUESTED') await this.sendFreezeRequested(p);
      else if (event.eventType === 'FREEZE_DECIDED') await this.sendFreezeDecided(p);

      await this.database.db
        .update(notificationEvents)
        .set({ status: 'SENT', sentAt: new Date() })
        .where(eq(notificationEvents.id, event.id));
    } catch (err) {
      this.logger.error(`Event ${event.id} failed`, err);
      await this.database.db
        .update(notificationEvents)
        .set({ status: 'FAILED' })
        .where(eq(notificationEvents.id, event.id));
    }
  }

  private async sendOpening(payload: Record<string, unknown>) {
    const localDate = payload.localDate as string;
    const trainerIds = payload.trainerIds as string[] | undefined;
    // Older events have no trainerIds: everyone, as before
    const subscriptions = trainerIds
      ? await this.subs.findForTrainers(trainerIds, payload.includeUnassigned === true)
      : await this.subs.findAll();
    await this.sendToSubs(subscriptions, {
      title: 'Запис відкрито! 🏋️',
      body: `Записуйтесь на тренування ${this.fmtDate(localDate)}`,
      icon: ICON,
      url: '/',
    });
  }

  private async sendCancellation(payload: Record<string, unknown>) {
    const memberIds = payload.memberIds as string[];
    const slotTime = payload.slotTime as string;
    const localDate = payload.localDate as string;
    const subscriptions = await this.subs.findActiveByMemberIds(memberIds);
    await this.sendToSubs(subscriptions, {
      title: 'Тренування скасовано',
      body: `Ваш запис на ${slotTime} ${this.fmtDate(localDate)} скасовано`,
      icon: ICON,
      url: '/',
    });
  }

  private async sendVacancy(payload: Record<string, unknown>) {
    const slotId = payload.slotId as string;
    const slotTime = payload.slotTime as string;
    const localDate = payload.localDate as string;
    const excludeMemberId = payload.excludeMemberId as string | undefined;

    const memberIds = await this.vacancyAlerts.findActiveSubscribersBySlot(slotId, excludeMemberId);
    const subscriptions = await this.subs.findActiveByMemberIds(memberIds);
    await this.sendToSubs(subscriptions, {
      title: "З'явилось місце! 🎉",
      body: `Вільне місце на ${slotTime} ${this.fmtDate(localDate)}. Записуйтесь!`,
      icon: ICON,
      url: '/',
    });
    await this.vacancyAlerts.deactivateBySlot(slotId);
  }

  // To the trainer: a member cancelled or moved a booking, with the reason they wrote
  private async sendMemberCancelled(payload: Record<string, unknown>) {
    const displayName = payload.displayName as string;
    const slotTime = payload.slotTime as string;
    const localDate = payload.localDate as string;
    const reason = payload.reason as string;
    const switchedToTime = payload.switchedToTime as string | null;
    const trainerId = payload.trainerId as string | null | undefined;

    const title = switchedToTime
      ? `Перенесення ${slotTime} → ${switchedToTime}, ${this.fmtDate(localDate)}`
      : `Скасування ${slotTime}, ${this.fmtDate(localDate)}`;
    // The trainer whose training it is (older events without trainerId go to every trainer)
    const subscriptions = trainerId ? await this.subs.findAdminByAdminId(trainerId) : await this.subs.findAllAdmin();
    for (const sub of subscriptions) {
      const result = await this.push.send(sub, { title, body: `${displayName}: ${reason}`, icon: ICON, url: '/admin' });
      if (result === 'expired') await this.subs.disableAdminByEndpoint(sub.endpoint);
    }
  }

  // To the member's trainer: they want to pay cash for a purchase (confirmed on «Клієнти»)
  private async sendCashRequested(payload: Record<string, unknown>) {
    const subscriptions = await this.subs.findAdminByAdminId(payload.trainerId as string);
    const body = `${payload.displayName as string}: ${payload.totalUah as number} ₴`;
    for (const sub of subscriptions) {
      const result = await this.push.send(sub, { title: 'Оплата готівкою', body, icon: ICON, url: '/admin/clients' });
      if (result === 'expired') await this.subs.disableAdminByEndpoint(sub.endpoint);
    }
  }

  // To the member's trainer: a freeze or unfreeze to approve on «Клієнти». A client without a trainer: nobody
  // (every trainer sees the request there)
  private async sendFreezeRequested(payload: Record<string, unknown>) {
    const trainerId = payload.trainerId as string | null;
    if (!trainerId) return;
    const subscriptions = await this.subs.findAdminByAdminId(trainerId);
    const title = payload.kind === 'unfreeze' ? 'Запит на розморозку' : 'Запит на заморозку';
    for (const sub of subscriptions) {
      const result = await this.push.send(sub, {
        title,
        body: payload.displayName as string,
        icon: ICON,
        url: '/admin/clients',
      });
      if (result === 'expired') await this.subs.disableAdminByEndpoint(sub.endpoint);
    }
  }

  // To the member: the trainer approved or rejected their freeze / unfreeze
  private async sendFreezeDecided(payload: Record<string, unknown>) {
    const subscriptions = await this.subs.findActiveByMemberIds([payload.memberId as string]);
    const approved = payload.approved === true;
    const body =
      payload.kind === 'unfreeze'
        ? approved
          ? 'Абонемент розморожено, можна записуватись'
          : 'Тренер не підтвердив розморозку'
        : approved
          ? `Абонемент заморожено до ${this.fmtDate(payload.until as string)}`
          : 'Тренер не підтвердив заморозку';
    await this.sendToSubs(subscriptions, { title: 'Мій абонемент', body, icon: ICON, url: '/purchases' });
  }

  private async sendToSubs(subs: Array<{ endpoint: string; p256dh: string; auth: string }>, payload: PushPayload) {
    for (const sub of subs) {
      const result = await this.push.send(sub, payload);
      if (result === 'expired') await this.subs.disableByEndpoint(sub.endpoint);
    }
  }

  private fmtDate(localDate: string): string {
    const [, m, d] = localDate.split('-');
    return `${parseInt(d)}.${parseInt(m)}`;
  }
}
