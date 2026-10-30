import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { ClockService } from '../clock/clock.service';
import { clubCards, members, payments, priceItems, purchaseItems, purchases, trainingSlots } from '../database/schema';
import { EntitlementsService } from './entitlements.service';
import { PaymentService } from '../payment/payment.service';
import { NotificationService } from '../notifications/notification.service';
import type { CreatePurchaseDto } from './dto/create-purchase.dto';
import { lockMember, tryBookGroup, type GroupBookingResult } from '../booking/group-booking';
import { cardState } from './validity';
import { GROUP_TYPE } from '../schedule/training-types';
import { openFreeze } from '../freezes/freeze.store';
import { purchaseViews } from './purchase-views';

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
    case 'FROZEN':
      return new ConflictException('Membership frozen');
    case 'LATE_CANCELLED':
      return new ConflictException('Cancelled late');
  }
}

// The member's side: «Мій абонемент», buying, cancelling a purchase that awaits payment. The trainer's side is
// AdminPurchasesService
@Injectable()
export class PurchasesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
    private readonly payments: PaymentService,
    private readonly notifications: NotificationService,
  ) {}

  // «Мій абонемент»: what can be bought, what the member has, and the purchase that still awaits payment
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
      pending: pending ? (await purchaseViews(this.database.db, [pending.id]))[0] : null,
      // Cash goes to the member's trainer, so a member without one can only pay by LiqPay
      canPayCash: !!member?.trainerId,
    };
  }

  // Prices are read from the price list now: the client never sends an amount
  async create(memberId: string, dto: CreatePurchaseDto) {
    const items = await this.priceItemsOf(dto.priceItemIds);
    await this.checkCanBuy(memberId, dto, items);

    // The club card goes first, as on the page
    const lines = [...sectionOf(items, 'club_card'), ...sectionOf(items, 'assigned'), ...sectionOf(items, 'group')];
    const totalUah = lines.reduce((sum, l) => sum + l.amountUah, 0);
    const { purchaseId, trainerId, displayName } = await this.insertPurchase(memberId, dto, lines, totalUah);

    if (dto.method === 'LIQPAY') {
      return { purchaseId, checkout: await this.payments.checkoutPurchase(purchaseId, memberId) };
    }
    await this.notifications.enqueueAndProcess('CASH_REQUESTED', `cash-requested:${purchaseId}`, {
      trainerId: trainerId!,
      displayName,
      totalUah,
    });
    return { purchaseId };
  }

  // The price list rows asked for, with today's amounts (the client never sends a price)
  private async priceItemsOf(priceItemIds: string[]) {
    const ids = [...new Set(priceItemIds)];
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
    return items;
  }

  // What may be bought together and by whom; throws the reason otherwise. Nothing is written yet
  private async checkCanBuy(memberId: string, dto: CreatePurchaseDto, items: PriceLine[]) {
    // One purchase is: a group pass alone; or a club card, a trainer service, or both
    const groups = sectionOf(items, 'group');
    const services = sectionOf(items, 'assigned');
    const cards = sectionOf(items, 'club_card');
    const groupAlone = groups.length === 1 && items.length === 1;
    const cardAndService = groups.length === 0 && cards.length <= 1 && services.length <= 1;
    if (!groupAlone && !cardAndService) throw new BadRequestException('Not a valid set of items');
    if (dto.slotId && !groupAlone) throw new BadRequestException('A slot goes only with a group pass');
    if (dto.slotId) {
      // Checked before anything is written: an unknown id would fail the purchase insert on the foreign key (500)
      const [slot] = await this.database.db
        .select({ trainingType: trainingSlots.trainingType })
        .from(trainingSlots)
        .where(eq(trainingSlots.id, dto.slotId))
        .limit(1);
      if (slot?.trainingType !== GROUP_TYPE) throw new NotFoundException('Slot not found');
    }
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
  }

  // The purchase and its lines, under the member lock; cash for a group training also books it
  private async insertPurchase(memberId: string, dto: CreatePurchaseDto, lines: PriceLine[], totalUah: number) {
    return this.database.db.transaction(async (tx) => {
      // Locked, so two requests at once can't both start a purchase
      const member = await lockMember(tx, memberId);
      if (!member) throw new NotFoundException('Member not found');

      const [open] = await tx
        .select({ id: purchases.id })
        .from(purchases)
        .where(and(eq(purchases.memberId, memberId), eq(purchases.status, 'PENDING')))
        .limit(1);
      if (open) throw new ConflictException('You have an unpaid purchase');
      // Nothing new while frozen or asking to: the freeze pushes the dates of what the member has on approval
      if (await openFreeze(tx, memberId, this.clock.now().toISODate()!)) {
        throw new ConflictException('Membership frozen');
      }
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
  }

  async cancel(memberId: string, purchaseId: string) {
    const now = this.clock.now().toJSDate();
    await this.database.db.transaction(async (tx) => {
      // Payments first, then the purchase: the same lock order as the LiqPay paths, so a cancel and a callback
      // at once wait for each other instead of deadlocking. If the purchase turns out not to be cancellable,
      // the throw below rolls this back
      await tx
        .update(payments)
        .set({ status: 'REPLACED', updatedAt: now })
        .where(and(eq(payments.purchaseId, purchaseId), eq(payments.status, 'PENDING')));
      const [cancelled] = await tx
        .update(purchases)
        .set({ status: 'CANCELLED', decidedAt: now })
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
}

type PriceLine = {
  id: string;
  section: string;
  title: string;
  optionLabel: string | null;
  amountUah: number;
  trainingType: string | null;
};

const sectionOf = (items: PriceLine[], section: string) => items.filter((i) => i.section === section);
