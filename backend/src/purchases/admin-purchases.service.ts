import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
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

// Latest purchases shown on a client's page
const MEMBER_PURCHASES_LIMIT = 20;

type Db = DatabaseService['db'];
type Q = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

// The trainer's side of purchases: cash requests of own clients («Отримано» / «Відхилити»), «Гроші без покупки»,
// «Повернути гроші», a client's club cards, packages and purchase history
@Injectable()
export class AdminPurchasesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationService,
  ) {}

  // Cash requests waiting for this trainer, oldest first
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

  // Money that LiqPay took after its purchase had ended (cancelled, expired or paid by another attempt): nothing was
  // given for it. Shown to the member's trainer (or every trainer for a client without one) until «Розібрано»
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
      rows.map((r) => r.purchaseId!),
    );
    return rows.map(({ purchaseId, paidAt, ...r }) => ({
      ...r,
      paidAt: paidAt.toISOString(),
      lines: views.find((v) => v.id === purchaseId)?.lines ?? [],
    }));
  }

  // «Розібрано»: compare-and-set, so two trainers can't both handle it
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
    const freed = await this.database.db.transaction(async (tx) => {
      const { bookingId } = await this.decideCash(tx, trainerId, purchaseId, 'REJECTED');
      if (!bookingId) return null;
      const [cancelled] = await tx
        .update(bookings)
        .set({ status: 'CANCELLED', cancelledAt: this.clock.now().toJSDate() })
        .where(and(eq(bookings.id, bookingId), eq(bookings.status, 'ACTIVE')))
        .returning({ slotId: bookings.slotId, memberId: bookings.memberId });
      // The member already cancelled it: a late cancellation keeps what it spent (booking/cancel-fee.ts)
      if (!cancelled) return null;
      await tx.delete(packageSpends).where(eq(packageSpends.bookingId, bookingId));
      await tx.delete(attendance).where(eq(attendance.bookingId, bookingId));
      // Their guest goes with the booking
      const seats = 1 + (await cancelGuests(tx, [bookingId], this.clock.now().toJSDate())).size;
      return (await freeSeats(tx, cancelled.slotId, seats)) ? { bookingId, ...cancelled } : null;
    });

    // A seat freed in a full group training: «З'явилось місце» to those waiting, as when a member cancels
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

  // «Повернути гроші»: half of a single personal / split training, after a member cancelled it 2–24 hours before
  // (booking/cancel-fee.ts). Own and unassigned clients, oldest first. The trainer returns the money themselves
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

  // «Повернено». Compare-and-set; another trainer's client answers 404, already handled 409
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

  // «+ Додати клубну карту з рецепції»: a card bought at the reception, waiting or (activate) active from today
  async addCard(trainerId: string, memberId: string, priceItemId: string, activate: boolean) {
    await requireVisibleMember(this.database.db, trainerId, memberId);
    await this.database.db.transaction(async (tx) => {
      // The member lock: a second «Додати» at once waits and then finds this card; a freeze approved meanwhile too
      await lockMember(tx, memberId);
      await this.rejectFrozen(tx, memberId);
      // One club card at a time: a new one only once the current card has ended or burned
      if (await this.entitlements.usableCard(memberId, tx))
        throw new ConflictException('Member already has a club card');
      await this.entitlements.addManualCard(tx, memberId, trainerId, priceItemId, activate);
    });
    return { ok: true };
  }

  // «Активувати з сьогодні»
  async activateCard(trainerId: string, memberId: string, cardId: string) {
    await requireVisibleMember(this.database.db, trainerId, memberId);
    await this.database.db.transaction(async (tx) => {
      // Under the member lock, as a freeze's approval: the card is either started first (and its dates pushed by the
      // freeze) or refused as frozen
      await lockMember(tx, memberId);
      await this.rejectFrozen(tx, memberId);
      await this.entitlements.activateCard(tx, memberId, cardId);
    });
    return { ok: true };
  }

  // A card added or started during a freeze would miss the pushed dates: after the unfreeze
  private async rejectFrozen(db: Q, memberId: string) {
    if (await memberFrozenOn(db, memberId, this.clock.now().toISODate()!)) {
      throw new ConflictException('Member is frozen');
    }
  }
}

// LiqPay said success, but the payment was never applied (PaymentService.needsManualHandling)
function strayPayment() {
  return and(
    isNotNull(payments.purchaseId),
    ne(payments.status, 'PAID'),
    sql`${payments.rawCallback}->>'status' in ('success', 'sandbox')`,
  );
}
