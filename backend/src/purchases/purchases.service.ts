import { Injectable, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { ClockService } from '../clock/clock.service';
import {
  admins,
  attendance,
  bookings,
  clubCards,
  members,
  packageSpends,
  payments,
  priceItems,
  purchaseItems,
  purchases,
  trainingSlots,
} from '../database/schema';
import { EntitlementsService } from './entitlements.service';
import { PaymentService } from '../payment/payment.service';
import { NotificationService } from '../notifications/notification.service';
import type { CreatePurchaseDto } from './dto/create-purchase.dto';
import { tryBookGroup, type GroupBookingResult } from '../booking/group-booking';
import { cardState } from './validity';

// Same answers as BookingService.book gives for the same reasons
function bookingError(reason: Extract<GroupBookingResult, { ok: false }>['reason']) {
  switch (reason) {
    case 'NOT_FOUND':
      return new NotFoundException('Slot not found');
    case 'CANCELLED':
      return new ConflictException('Slot is cancelled');
    case 'NOT_SCHEDULED':
      return new ConflictException('Training day is not scheduled');
    case 'WINDOW':
      return new BadRequestException('Booking window has closed');
    case 'FULL':
      return new ConflictException('Slot is full');
    case 'ALREADY_BOOKED':
      return new ConflictException('You already have an active booking for this day');
  }
}

// Latest purchases shown on a client's page
const MEMBER_PURCHASES_LIMIT = 20;

type Db = DatabaseService['db'];
type Q = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type PurchaseView = {
  id: string;
  method: string;
  status: string;
  totalUah: number;
  createdAt: string;
  // section: the price list section (club_card | assigned | group), so a club card line can say so
  lines: { section: string; title: string; optionLabel: string | null; amountUah: number }[];
};

@Injectable()
export class PurchasesService {
  private readonly logger = new Logger(PurchasesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
    private readonly payments: PaymentService,
    private readonly notifications: NotificationService,
  ) {}

  // «Мої покупки»: what can be bought, what the member has, and the purchase that still awaits payment
  async getForMember(memberId: string) {
    const catalog = await this.database.db
      .select({
        id: priceItems.id,
        section: priceItems.section,
        title: priceItems.title,
        optionLabel: priceItems.optionLabel,
        amountUah: priceItems.amountUah,
        durationMonths: priceItems.durationMonths,
        trainingType: priceItems.trainingType,
        trainingCount: priceItems.trainingCount,
      })
      .from(priceItems)
      .where(inArray(priceItems.section, ['club_card', 'assigned', 'group']))
      .orderBy(asc(priceItems.sortOrder));

    const [member] = await this.database.db
      .select({ trainerId: members.trainerId })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    const [pending] = await this.database.db
      .select({ id: purchases.id })
      .from(purchases)
      .where(and(eq(purchases.memberId, memberId), eq(purchases.status, 'PENDING')))
      .limit(1);
    // The latest card with its state, so a member whose card burned or ended sees why there is none
    const [latest] = await this.database.db
      .select({
        label: clubCards.label,
        activateBy: clubCards.activateBy,
        validFrom: clubCards.validFrom,
        validUntil: clubCards.validUntil,
      })
      .from(clubCards)
      .where(eq(clubCards.memberId, memberId))
      .orderBy(desc(clubCards.createdAt))
      .limit(1);

    return {
      catalog: {
        clubCards: catalog.filter((c) => c.section === 'club_card'),
        services: catalog.filter((c) => c.section === 'assigned'),
        groupPasses: catalog.filter((c) => c.section === 'group'),
      },
      card: await this.entitlements.usableCard(memberId),
      lastCard: latest
        ? {
            label: latest.label,
            state: cardState(latest, this.clock.now().toISODate()!),
            activateBy: latest.activateBy,
            validUntil: latest.validUntil,
          }
        : null,
      packages: await this.entitlements.packagesOf(memberId),
      pending: pending ? (await this.views([pending.id]))[0] : null,
      // Cash goes to the member's trainer, so a member without one can only pay by LiqPay
      canPayCash: !!member?.trainerId,
    };
  }

  // Prices are read from the price list now: the client never sends an amount
  async create(memberId: string, dto: CreatePurchaseDto) {
    const ids = [...new Set(dto.priceItemIds)];
    const items = await this.database.db
      .select({
        id: priceItems.id,
        section: priceItems.section,
        title: priceItems.title,
        optionLabel: priceItems.optionLabel,
        amountUah: priceItems.amountUah,
        trainingType: priceItems.trainingType,
      })
      .from(priceItems)
      .where(inArray(priceItems.id, ids));
    if (items.length !== ids.length) throw new NotFoundException('Price not found');

    // One purchase is: a group pass alone; or a club card, a trainer service, or both
    const groups = items.filter((i) => i.section === 'group');
    const services = items.filter((i) => i.section === 'assigned');
    const cards = items.filter((i) => i.section === 'club_card');
    const groupAlone = groups.length === 1 && items.length === 1;
    const cardAndService = groups.length === 0 && cards.length <= 1 && services.length <= 1;
    if (!groupAlone && !cardAndService) throw new BadRequestException('Not a valid set of items');
    if (dto.slotId && !groupAlone) throw new BadRequestException('A slot goes only with a group pass');
    if (cards.length || services.length) {
      const hasCard = !!(await this.entitlements.usableCard(memberId));
      // One club card at a time: a new one only once the current card has ended or burned
      if (cards.length && hasCard) throw new ConflictException('Member already has a club card');
      if (services.length && !cards.length && !hasCard) throw new BadRequestException('Club card required');
    }

    // No buying ahead: more trainings of a type only once the member has none of it left to use
    const passType = (groups[0] ?? services[0])?.trainingType;
    if (passType) {
      const own = await this.entitlements.packagesOf(memberId);
      const unused = own.some(
        (p) => p.trainingType === passType && p.left > 0 && (p.state === 'waiting' || p.state === 'active'),
      );
      if (unused) throw new ConflictException('Member still has trainings of this type');
    }

    // The club card goes first, as on the page
    const lines = [...cards, ...services, ...groups];
    const totalUah = lines.reduce((sum, l) => sum + l.amountUah, 0);

    const { purchaseId, trainerId, displayName } = await this.database.db.transaction(async (tx) => {
      // Locked, so two requests at once can't both start a purchase
      const [member] = await tx
        .select({ trainerId: members.trainerId, displayName: members.displayName })
        .from(members)
        .where(eq(members.id, memberId))
        .for('update')
        .limit(1);
      if (!member) throw new NotFoundException('Member not found');

      const [open] = await tx
        .select({ id: purchases.id })
        .from(purchases)
        .where(and(eq(purchases.memberId, memberId), eq(purchases.status, 'PENDING')))
        .limit(1);
      if (open) throw new ConflictException('You have an unpaid purchase');
      if (dto.method === 'CASH' && !member.trainerId) throw new BadRequestException('No trainer to pay cash to');

      const [created] = await tx
        .insert(purchases)
        .values({
          memberId,
          trainerId: member.trainerId,
          method: dto.method,
          status: 'PENDING',
          totalUah,
          slotId: dto.slotId ?? null,
        })
        .returning({ id: purchases.id });
      await tx.insert(purchaseItems).values(
        lines.map((l) => ({
          purchaseId: created.id,
          priceItemId: l.id,
          title: l.title,
          optionLabel: l.optionLabel,
          amountUah: l.amountUah,
        })),
      );
      // Cash for a group training: booked now, the trainer takes the money in the hall. Can't book → nothing is
      // bought (the throw rolls the purchase back)
      if (dto.method === 'CASH' && dto.slotId) {
        const booked = await tryBookGroup(tx, this.clock.now(), memberId, dto.slotId);
        if (!booked.ok) throw bookingError(booked.reason);
        await tx.update(purchases).set({ bookingId: booked.bookingId }).where(eq(purchases.id, created.id));
      }
      return { purchaseId: created.id, trainerId: member.trainerId, displayName: member.displayName };
    });

    if (dto.method === 'LIQPAY') {
      return { purchaseId, checkout: await this.payments.checkoutPurchase(purchaseId, memberId) };
    }
    await this.notifyCash(purchaseId, trainerId!, displayName, totalUah);
    return { purchaseId };
  }

  // The member changed their mind before paying. Open LiqPay attempts stop counting: money that still
  // arrives for one of them is handled by hand (PaymentService)
  async cancel(memberId: string, purchaseId: string) {
    await this.database.db.transaction(async (tx) => {
      // Payments first, then the purchase: the same lock order as the LiqPay paths, so a cancel and a callback
      // at once wait for each other instead of deadlocking. If the purchase turns out not to be cancellable,
      // the throw below rolls this back
      await tx
        .update(payments)
        .set({ status: 'REPLACED', updatedAt: new Date() })
        .where(and(eq(payments.purchaseId, purchaseId), eq(payments.status, 'PENDING')));
      const [cancelled] = await tx
        .update(purchases)
        .set({ status: 'CANCELLED', decidedAt: this.clock.now().toJSDate() })
        .where(and(eq(purchases.id, purchaseId), eq(purchases.memberId, memberId), eq(purchases.status, 'PENDING')))
        .returning({ id: purchases.id });
      if (!cancelled) {
        const [own] = await tx
          .select({ status: purchases.status })
          .from(purchases)
          .where(and(eq(purchases.id, purchaseId), eq(purchases.memberId, memberId)))
          .limit(1);
        if (!own) throw new NotFoundException('Purchase not found');
        throw new ConflictException('Purchase is no longer awaiting payment');
      }
    });
    return { ok: true };
  }

  // ── Trainer side ──────────────────────────────────────────────────────────

  // Cash requests waiting for this trainer, oldest first
  async pendingCash(trainerId: string) {
    const rows = await this.database.db
      .select({ id: purchases.id, memberId: purchases.memberId, displayName: members.displayName })
      .from(purchases)
      .innerJoin(members, eq(members.id, purchases.memberId))
      .where(and(eq(purchases.trainerId, trainerId), eq(purchases.method, 'CASH'), eq(purchases.status, 'PENDING')))
      .orderBy(asc(purchases.createdAt));
    const views = await this.views(rows.map((r) => r.id));
    return views.map((v) => {
      const row = rows.find((r) => r.id === v.id)!;
      return { ...v, memberId: row.memberId, displayName: row.displayName };
    });
  }

  // «Оплату отримано»: only the member's trainer, only a cash request still awaiting payment
  async confirmCash(trainerId: string, purchaseId: string) {
    await this.database.db.transaction(async (tx) => {
      await this.decideCash(tx, trainerId, purchaseId, 'PAID');
      await this.entitlements.activate(tx, purchaseId);
    });
    return { ok: true };
  }

  // The member never paid. Cash for a group training booked the seat at once: that booking goes too (no pay,
  // no seat), with any mark on it. A system cancellation, so no reason is shown as the member's
  async rejectCash(trainerId: string, purchaseId: string) {
    await this.database.db.transaction(async (tx) => {
      const { bookingId } = await this.decideCash(tx, trainerId, purchaseId, 'REJECTED');
      if (!bookingId) return;
      await tx.delete(packageSpends).where(eq(packageSpends.bookingId, bookingId));
      await tx.delete(attendance).where(eq(attendance.bookingId, bookingId));
      const [cancelled] = await tx
        .update(bookings)
        .set({ status: 'CANCELLED', cancelledAt: this.clock.now().toJSDate() })
        .where(and(eq(bookings.id, bookingId), eq(bookings.status, 'ACTIVE')))
        .returning({ slotId: bookings.slotId });
      if (!cancelled) return; // the member already cancelled it
      await tx
        .update(trainingSlots)
        .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - 1, 0)` })
        .where(eq(trainingSlots.id, cancelled.slotId));
    });
    return { ok: true };
  }

  // Compare-and-set, so a double tap can't confirm (and activate) twice. Another trainer's request
  // or a LiqPay purchase answers 404 like a missing one
  private async decideCash(tx: Q, trainerId: string, purchaseId: string, status: 'PAID' | 'REJECTED') {
    const mine = and(eq(purchases.id, purchaseId), eq(purchases.trainerId, trainerId), eq(purchases.method, 'CASH'));
    const [decided] = await tx
      .update(purchases)
      .set({ status, decidedBy: trainerId, decidedAt: this.clock.now().toJSDate() })
      .where(and(mine, eq(purchases.status, 'PENDING')))
      .returning({ id: purchases.id, bookingId: purchases.bookingId });
    if (decided) return decided;
    const [exists] = await tx.select({ status: purchases.status }).from(purchases).where(mine).limit(1);
    if (!exists) throw new NotFoundException('Purchase not found');
    throw new ConflictException('Purchase was already decided');
  }

  // A client's page: cards, packages and purchase history
  async memberPurchases(trainerId: string, memberId: string) {
    await this.visibleMember(trainerId, memberId);
    const cards = await this.database.db
      .select({
        id: clubCards.id,
        label: clubCards.label,
        validFrom: clubCards.validFrom,
        validUntil: clubCards.validUntil,
        activateBy: clubCards.activateBy,
        purchaseItemId: clubCards.purchaseItemId,
      })
      .from(clubCards)
      .where(eq(clubCards.memberId, memberId))
      .orderBy(desc(clubCards.createdAt));
    const history = await this.database.db
      .select({ id: purchases.id, decidedBy: admins.username })
      .from(purchases)
      .leftJoin(admins, eq(admins.id, purchases.decidedBy))
      .where(eq(purchases.memberId, memberId))
      .orderBy(desc(purchases.createdAt))
      .limit(MEMBER_PURCHASES_LIMIT);
    const views = await this.views(history.map((h) => h.id));

    return {
      card: await this.entitlements.usableCard(memberId),
      cards: cards.map(({ purchaseItemId, ...c }) => ({
        ...c,
        state: cardState(c, this.clock.now().toISODate()!),
        source: purchaseItemId ? 'purchase' : 'manual',
      })),
      packages: await this.entitlements.packagesOf(memberId),
      purchases: views.map((v) => ({ ...v, decidedBy: history.find((h) => h.id === v.id)?.decidedBy ?? null })),
    };
  }

  // «Додати карту вручну»: a card bought at the reception, waiting or (activate) active from today
  async addCard(trainerId: string, memberId: string, priceItemId: string, activate: boolean) {
    await this.visibleMember(trainerId, memberId);
    // One club card at a time: a new one only once the current card has ended or burned
    if (await this.entitlements.usableCard(memberId)) throw new ConflictException('Member already has a club card');
    await this.entitlements.addManualCard(this.database.db, memberId, trainerId, priceItemId, activate);
    return { ok: true };
  }

  // «Активувати з сьогодні»
  async activateCard(trainerId: string, memberId: string, cardId: string) {
    await this.visibleMember(trainerId, memberId);
    await this.entitlements.activateCard(this.database.db, memberId, cardId);
    return { ok: true };
  }

  // Same rule as the rest of the admin: own clients plus unassigned ones; anyone else's answers 404
  private async visibleMember(trainerId: string, memberId: string) {
    const [member] = await this.database.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, memberId), or(eq(members.trainerId, trainerId), isNull(members.trainerId))))
      .limit(1);
    if (!member) throw new NotFoundException('Member not found');
  }

  // Purchases with their lines, in the order of `ids`
  async views(ids: string[], db: Q = this.database.db): Promise<PurchaseView[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .select({
        id: purchases.id,
        method: purchases.method,
        status: purchases.status,
        totalUah: purchases.totalUah,
        createdAt: purchases.createdAt,
      })
      .from(purchases)
      .where(inArray(purchases.id, ids));
    const lines = await db
      .select({
        purchaseId: purchaseItems.purchaseId,
        section: priceItems.section,
        title: purchaseItems.title,
        optionLabel: purchaseItems.optionLabel,
        amountUah: purchaseItems.amountUah,
      })
      .from(purchaseItems)
      .innerJoin(priceItems, eq(priceItems.id, purchaseItems.priceItemId))
      .where(inArray(purchaseItems.purchaseId, ids));
    return ids
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is (typeof rows)[number] => !!r)
      .map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        lines: lines
          .filter((l) => l.purchaseId === r.id)
          .map((l) => ({ section: l.section, title: l.title, optionLabel: l.optionLabel, amountUah: l.amountUah })),
      }));
  }

  // A failed push never fails the member's request
  private async notifyCash(purchaseId: string, trainerId: string, displayName: string, totalUah: number) {
    try {
      await this.notifications.enqueueAndProcess('CASH_REQUESTED', `cash-requested:${purchaseId}`, {
        trainerId,
        displayName,
        totalUah,
      });
    } catch (err) {
      this.logger.error(`Cash request push for purchase ${purchaseId} failed`, err);
    }
  }
}
