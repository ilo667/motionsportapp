import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { ClockService } from '../clock/clock.service';
import {
  admins,
  attendance,
  bookings,
  cancelRefunds,
  trainingDays,
  clubCards,
  members,
  packageSpends,
  payments,
  purchases,
  trainingSlots,
} from '../database/schema';
import { EntitlementsService } from './entitlements.service';
import { NotificationService } from '../notifications/notification.service';
import { cancelGuests, freeSeats, lockMember } from '../booking/group-booking';
import { cardState } from './validity';
import { memberFrozenOn } from '../freezes/freeze.store';
import { requireVisibleMember, visibleTo } from '../schedule/default-trainer';
import { purchaseViews } from './purchase-views';
import { apiError } from '../common/api-error';

const MEMBER_PURCHASES_LIMIT = 20;

type Db = DatabaseService['db'];
type Q = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

@Injectable()
export class AdminPurchasesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationService,
  ) {}

  async pendingCash(trainerId: string) {
    const rows = await this.database.db
      .select({ id: purchases.id, memberId: purchases.memberId, displayName: members.displayName })
      .from(purchases)
      .innerJoin(members, eq(members.id, purchases.memberId))
      .where(and(eq(purchases.trainerId, trainerId), eq(purchases.method, 'CASH'), eq(purchases.status, 'PENDING')))
      .orderBy(asc(purchases.createdAt));
    const views = await purchaseViews(
      this.database.db,
      rows.map((r) => r.id),
    );
    return views.map((v) => {
      const row = rows.find((r) => r.id === v.id)!;
      return { ...v, memberId: row.memberId, displayName: row.displayName };
    });
  }

  // «Гроші без покупки»: LiqPay took money after the purchase ended, nothing was given for it
  async strayPayments(trainerId: string) {
    const rows = await this.database.db
      .select({
        paymentId: payments.id,
        purchaseId: payments.purchaseId,
        memberId: members.id,
        displayName: members.displayName,
        amountUah: payments.amount,
        liqpayPaymentId: payments.liqpayPaymentId,
        paidAt: payments.updatedAt,
      })
      .from(payments)
      .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
      .innerJoin(members, eq(members.id, purchases.memberId))
      .where(and(strayPayment(), isNull(payments.handledAt), visibleTo(trainerId)))
      .orderBy(asc(payments.updatedAt));
    const views = await purchaseViews(
      this.database.db,
      rows.map((r) => r.purchaseId),
    );
    return rows.map(({ purchaseId, paidAt, ...r }) => ({
      ...r,
      paidAt: paidAt.toISOString(),
      lines: views.find((v) => v.id === purchaseId)?.lines ?? [],
    }));
  }

  // «Розібрано». Compare-and-set: two trainers can't both handle it
  async markPaymentHandled(trainerId: string, paymentId: string) {
    const [payment] = await this.database.db
      .select({ handledAt: payments.handledAt })
      .from(payments)
      .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
      .innerJoin(members, eq(members.id, purchases.memberId))
      .where(and(eq(payments.id, paymentId), strayPayment(), visibleTo(trainerId)))
      .limit(1);
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.handledAt) throw new ConflictException('Payment already handled');
    const [won] = await this.database.db
      .update(payments)
      .set({ handledAt: this.clock.now().toJSDate(), handledByAdminId: trainerId })
      .where(and(eq(payments.id, paymentId), isNull(payments.handledAt)))
      .returning({ id: payments.id });
    if (!won) throw new ConflictException('Payment already handled');
    return { ok: true };
  }

  async confirmCash(trainerId: string, purchaseId: string) {
    await this.database.db.transaction(async (tx) => {
      await this.decideCash(tx, trainerId, purchaseId, 'PAID');
      await this.entitlements.activate(tx, purchaseId);
    });
    return { ok: true };
  }

  // A cash group pass booked its slot at once: cancel that booking and its mark (system cancellation)
  async rejectCash(trainerId: string, purchaseId: string) {
    const freed = await this.database.db.transaction(async (tx) => {
      const { bookingId } = await this.decideCash(tx, trainerId, purchaseId, 'REJECTED');
      if (!bookingId) return null;
      const [cancelled] = await tx
        .update(bookings)
        .set({ status: 'CANCELLED', cancelledAt: this.clock.now().toJSDate() })
        .where(and(eq(bookings.id, bookingId), eq(bookings.status, 'ACTIVE')))
        .returning({ slotId: bookings.slotId, memberId: bookings.memberId });
      // Already cancelled by the member: a late-cancellation fee keeps its spend
      if (!cancelled) return null;
      await tx.delete(packageSpends).where(eq(packageSpends.bookingId, bookingId));
      await tx.delete(attendance).where(eq(attendance.bookingId, bookingId));
      const seats = 1 + (await cancelGuests(tx, [bookingId], this.clock.now().toJSDate())).size;
      return (await freeSeats(tx, cancelled.slotId, seats)) ? { bookingId, ...cancelled } : null;
    });

    // Freed a seat in a full group training: vacancy alert, as on a member cancel
    if (freed) {
      const [slot] = await this.database.db
        .select({ slotTime: trainingSlots.slotTime, localDate: trainingDays.localDate })
        .from(trainingSlots)
        .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
        .where(eq(trainingSlots.id, freed.slotId))
        .limit(1);
      if (slot) {
        await this.notifications.enqueueAndProcess('VACANCY', `vacancy:${freed.slotId}:${freed.bookingId}`, {
          slotId: freed.slotId,
          slotTime: slot.slotTime,
          localDate: slot.localDate,
          excludeMemberId: freed.memberId,
        });
      }
    }
    return { ok: true };
  }

  // «Повернути гроші»: half refunds for late cancellations (booking/cancel-fee.ts). Paid out by hand
  async pendingCancelRefunds(trainerId: string) {
    const rows = await this.database.db
      .select({
        id: cancelRefunds.id,
        memberId: cancelRefunds.memberId,
        displayName: members.displayName,
        amountUah: cancelRefunds.amountUah,
        method: purchases.method,
        createdAt: cancelRefunds.createdAt,
        localDate: trainingDays.localDate,
        slotTime: trainingSlots.slotTime,
        trainingType: trainingSlots.trainingType,
      })
      .from(cancelRefunds)
      .innerJoin(members, eq(members.id, cancelRefunds.memberId))
      .innerJoin(purchases, eq(purchases.id, cancelRefunds.purchaseId))
      .innerJoin(bookings, eq(bookings.id, cancelRefunds.bookingId))
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .where(and(eq(cancelRefunds.status, 'DUE'), visibleTo(trainerId)))
      .orderBy(asc(cancelRefunds.createdAt));
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  // «Повернено». Compare-and-set
  async markCancelRefundDone(trainerId: string, refundId: string) {
    const [refund] = await this.database.db
      .select({ memberId: cancelRefunds.memberId })
      .from(cancelRefunds)
      .where(eq(cancelRefunds.id, refundId))
      .limit(1);
    if (!refund) throw new NotFoundException('Refund not found');
    await requireVisibleMember(this.database.db, trainerId, refund.memberId);
    const [done] = await this.database.db
      .update(cancelRefunds)
      .set({ status: 'DONE', doneAt: this.clock.now().toJSDate(), doneBy: trainerId })
      .where(and(eq(cancelRefunds.id, refundId), eq(cancelRefunds.status, 'DUE')))
      .returning({ id: cancelRefunds.id });
    if (!done) throw new ConflictException('Refund was already handled');
    return { ok: true };
  }

  // Compare-and-set: a double tap can't activate twice. Another trainer's or a LiqPay purchase: 404
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

  async memberPurchases(trainerId: string, memberId: string) {
    await requireVisibleMember(this.database.db, trainerId, memberId);
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
    const views = await purchaseViews(
      this.database.db,
      history.map((h) => h.id),
    );

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

  // «+ Додати клубну карту з рецепції»
  async addCard(trainerId: string, memberId: string, priceItemId: string, activate: boolean) {
    await requireVisibleMember(this.database.db, trainerId, memberId);
    await this.database.db.transaction(async (tx) => {
      // Serialises with a concurrent add (finds this card) and a freeze approval
      await lockMember(tx, memberId);
      await this.rejectFrozen(tx, memberId);
      if (await this.entitlements.usableCard(memberId, tx)) throw new ConflictException(apiError('CLUB_CARD_EXISTS'));
      await this.entitlements.addManualCard(tx, memberId, trainerId, priceItemId, activate);
    });
    return { ok: true };
  }

  async activateCard(trainerId: string, memberId: string, cardId: string) {
    await requireVisibleMember(this.database.db, trainerId, memberId);
    await this.database.db.transaction(async (tx) => {
      // Serialises with freeze approval: started first (then pushed by the freeze) or refused as frozen
      await lockMember(tx, memberId);
      await this.rejectFrozen(tx, memberId);
      await this.entitlements.activateCard(tx, memberId, cardId);
    });
    return { ok: true };
  }

  // A card added or started mid-freeze would miss the pushed dates
  private async rejectFrozen(db: Q, memberId: string) {
    if (await memberFrozenOn(db, memberId, this.clock.now().toISODate()!)) {
      throw new ConflictException(apiError('MEMBER_FROZEN'));
    }
  }
}

// LiqPay success that was never applied (PaymentService.needsManualHandling)
function strayPayment() {
  return and(ne(payments.status, 'PAID'), sql`${payments.rawCallback}->>'status' in ('success', 'sandbox')`);
}
