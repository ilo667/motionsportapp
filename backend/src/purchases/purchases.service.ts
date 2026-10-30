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
import { apiError } from '../common/api-error';

// Same errors as BookingService.book
function bookingError(reason: Extract<GroupBookingResult, { ok: false }>['reason']) {
  switch (reason) {
    case 'NOT_FOUND':
      return new NotFoundException(apiError('SLOT_NOT_FOUND'));
    case 'CANCELLED':
      return new ConflictException(apiError('SLOT_CANCELLED'));
    case 'NOT_SCHEDULED':
      return new ConflictException(apiError('DAY_NOT_SCHEDULED'));
    case 'WINDOW':
      return new BadRequestException(apiError('BOOKING_CLOSED'));
    case 'FULL':
      return new ConflictException(apiError('SLOT_FULL'));
    case 'ALREADY_BOOKED':
      return new ConflictException(apiError('ALREADY_BOOKED_TODAY'));
    case 'FROZEN':
      return new ConflictException(apiError('MEMBERSHIP_FROZEN'));
    case 'LATE_CANCELLED':
      return new ConflictException(apiError('CANCELLED_LATE'));
  }
}

// Member side; the trainer side is AdminPurchasesService
@Injectable()
export class PurchasesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
    private readonly payments: PaymentService,
    private readonly notifications: NotificationService,
  ) {}

  // «Мій абонемент»
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
    // So a member whose card burned or ended sees why there is none
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
      // Cash is paid to the member's trainer
      canPayCash: !!member?.trainerId,
    };
  }

  async create(memberId: string, dto: CreatePurchaseDto) {
    const items = await this.priceItemsOf(dto.priceItemIds);
    await this.checkCanBuy(memberId, dto, items);

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

  // Current amounts from the price list; the client never sends a price
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

  private async checkCanBuy(memberId: string, dto: CreatePurchaseDto, items: PriceLine[]) {
    // Allowed: a group pass alone; or a club card, a trainer service, or both
    const groups = sectionOf(items, 'group');
    const services = sectionOf(items, 'assigned');
    const cards = sectionOf(items, 'club_card');
    const groupAlone = groups.length === 1 && items.length === 1;
    const cardAndService = groups.length === 0 && cards.length <= 1 && services.length <= 1;
    if (!groupAlone && !cardAndService) throw new BadRequestException('Not a valid set of items');
    if (dto.slotId && !groupAlone) throw new BadRequestException('A slot goes only with a group pass');
    if (dto.slotId) {
      // Before any write: an unknown id would fail the insert on the foreign key (500)
      const [slot] = await this.database.db
        .select({ trainingType: trainingSlots.trainingType })
        .from(trainingSlots)
        .where(eq(trainingSlots.id, dto.slotId))
        .limit(1);
      if (slot?.trainingType !== GROUP_TYPE) throw new NotFoundException(apiError('SLOT_NOT_FOUND'));
    }
    if (cards.length || services.length) {
      const hasCard = !!(await this.entitlements.usableCard(memberId));
      if (cards.length && hasCard) throw new ConflictException(apiError('CLUB_CARD_EXISTS'));
      if (services.length && !cards.length && !hasCard) throw new BadRequestException(apiError('CLUB_CARD_REQUIRED'));
    }

    // No buying ahead: only once no usable trainings of that type are left
    const passType = (groups[0] ?? services[0])?.trainingType;
    if (passType) {
      const own = await this.entitlements.packagesOf(memberId);
      const unused = own.some(
        (p) => p.trainingType === passType && p.left > 0 && (p.state === 'waiting' || p.state === 'active'),
      );
      if (unused) throw new ConflictException(apiError('TRAININGS_LEFT'));
    }
  }

  private async insertPurchase(memberId: string, dto: CreatePurchaseDto, lines: PriceLine[], totalUah: number) {
    return this.database.db.transaction(async (tx) => {
      const member = await lockMember(tx, memberId);
      if (!member) throw new NotFoundException('Member not found');

      const [open] = await tx
        .select({ id: purchases.id })
        .from(purchases)
        .where(and(eq(purchases.memberId, memberId), eq(purchases.status, 'PENDING')))
        .limit(1);
      if (open) throw new ConflictException(apiError('UNPAID_PURCHASE'));
      // Freeze approval pushes the dates of what exists; a new purchase would miss that
      if (await openFreeze(tx, memberId, this.clock.now().toISODate()!)) {
        throw new ConflictException(apiError('MEMBERSHIP_FROZEN'));
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
      // Cash group pass: book now, paid in the hall. Can't book: the throw rolls the purchase back
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
      // Payments before purchase: same lock order as the LiqPay paths, so no deadlock with a callback.
      // The throw below rolls this back if the purchase can't be cancelled
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
