import { Injectable, ConflictException, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { trainingSlots, trainingDays, bookings, payments, slotMembers } from '../database/schema';
import { DemoService } from '../demo/demo.service';
import { ASSIGNED_TYPES, slotStartsAt } from '../schedule/training-types';
import { liqpaySign, liqpayEncode, liqpayDecode, liqpayVerify, liqpayStatus } from './liqpay.helper';

const PAYMENT_TYPES = ASSIGNED_TYPES;
const SUCCESS_STATUSES = ['success', 'sandbox'];
const FAILED_STATUSES = ['failure', 'error', 'reversed'];

// REPLACED: superseded by a newer attempt for the same booking (member pressed "Оплатити" again)
export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REPLACED';

const LOGGED_LIQPAY_FIELDS = [
  'result', 'order_id', 'status', 'err_code', 'err_description', 'action', 'paytype',
  'payment_id', 'liqpay_order_id', 'amount', 'currency', 'create_date', 'end_date',
];

function newOrderId(bookingId: string) {
  return `mg-${Date.now()}-${bookingId.substring(0, 8)}`;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly demoService: DemoService,
  ) {}

  private get publicKey() { return process.env.LIQPAY_PUBLIC_KEY ?? ''; }
  private get privateKey() { return process.env.LIQPAY_PRIVATE_KEY ?? ''; }
  private get amount() { return parseInt(process.env.LIQPAY_AMOUNT ?? '700', 10); }
  // Lower it (e.g. 2) to test expiry without waiting
  private get expiryMs() { return parseInt(process.env.PAYMENT_EXPIRY_MINUTES ?? '15', 10) * 60 * 1000; }

  async createCheckout(slotId: string, memberId: string) {
    if (!this.publicKey || !this.privateKey) {
      throw new BadRequestException('Payment is not configured');
    }

    const [slot] = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.id, slotId))
      .limit(1);

    if (!slot) throw new NotFoundException('Slot not found');
    if (slot.status !== 'ACTIVE') throw new ConflictException('Slot is cancelled');
    if (!PAYMENT_TYPES.includes(slot.trainingType)) {
      throw new BadRequestException('This slot does not require payment');
    }

    // Assigned slots are visible and payable only for the members the coach assigned
    const [assigned] = await this.database.db
      .select({ memberId: slotMembers.memberId })
      .from(slotMembers)
      .where(and(eq(slotMembers.slotId, slotId), eq(slotMembers.memberId, memberId)))
      .limit(1);
    if (!assigned) throw new NotFoundException('Slot not found');

    const [day] = await this.database.db
      .select({ localDate: trainingDays.localDate, status: trainingDays.status })
      .from(trainingDays)
      .where(eq(trainingDays.id, slot.trainingDayId))
      .limit(1);
    if (!day || day.status !== 'SCHEDULED') throw new ConflictException('Training day is not scheduled');
    if ((await this.demoService.getNow()) >= slotStartsAt(day.localDate, slot.slotTime)) {
      throw new BadRequestException('Training has already started');
    }

    // "Оплатити" on an own PENDING booking continues that booking instead of creating a new one
    const resumed = await this.resumePendingCheckout(slotId, memberId);
    if (resumed === 'PAID') {
      this.logger.log(`Checkout: member=${memberId} slot=${slotId} — previous attempt already paid, no redirect`);
      return { status: 'PAID' as const };
    }
    if (resumed) return this.buildCheckout(resumed);

    let orderId = '';

    try {
      await this.database.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(trainingSlots)
          .where(eq(trainingSlots.id, slotId))
          .for('update')
          .limit(1);

        if (!locked || locked.status !== 'ACTIVE') throw new ConflictException('Slot is no longer available');
        if (locked.bookedCount >= locked.capacity) throw new ConflictException('Slot is full');

        // Assigned bookings don't limit other bookings that day, only a second one on the same slot
        const [existing] = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(and(eq(bookings.memberId, memberId), eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')))
          .limit(1);

        if (existing) throw new ConflictException('You already booked this training');

        const [inserted] = await tx
          .insert(bookings)
          .values({ memberId, trainingDayId: locked.trainingDayId, slotId, status: 'ACTIVE', paymentStatus: 'PENDING' })
          .returning({ id: bookings.id });

        orderId = newOrderId(inserted.id);

        await tx.insert(payments).values({
          bookingId: inserted.id,
          orderId,
          amount: this.amount,
          currency: 'UAH',
          status: 'PENDING',
        });

        await tx
          .update(trainingSlots)
          .set({ bookedCount: sql`${trainingSlots.bookedCount} + 1` })
          .where(eq(trainingSlots.id, slotId));
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException('You already booked this training');
      }
      throw err;
    }

    this.logger.log(`Checkout: member=${memberId} slot=${slotId} — new booking, order=${orderId}`);
    return this.buildCheckout(orderId);
  }

  // Returns a fresh order id for the member's PENDING booking on this slot, 'PAID' if LiqPay says
  // the previous attempt actually succeeded, or null when there is nothing to resume.
  private async resumePendingCheckout(slotId: string, memberId: string): Promise<string | 'PAID' | null> {
    const [pending] = await this.database.db
      .select({ id: payments.id, bookingId: payments.bookingId, orderId: payments.orderId })
      .from(payments)
      .innerJoin(bookings, eq(bookings.id, payments.bookingId))
      .where(
        and(
          eq(bookings.memberId, memberId),
          eq(bookings.slotId, slotId),
          eq(bookings.status, 'ACTIVE'),
          eq(payments.status, 'PENDING'),
        ),
      )
      .limit(1);

    if (!pending) return null;

    const remote = await this.fetchLiqpayStatus(pending.orderId);
    if (remote?.result === 'ok') {
      const applied = await this.applyLiqpayStatus(pending, remote);
      if (applied === 'PAID') return 'PAID';
      if (applied === 'FAILED') {
        this.logger.log(`Checkout: previous order=${pending.orderId} failed — creating a fresh booking`);
        return null; // booking cancelled, seat freed — caller creates a fresh one
      }
    }

    // LiqPay may refuse to reuse an order_id that already had an attempt, so issue a new one for the same booking
    const orderId = newOrderId(pending.bookingId);
    await this.database.db.transaction(async (tx) => {
      const replaced = await tx
        .update(payments)
        .set({ status: 'REPLACED', updatedAt: new Date() })
        .where(and(eq(payments.id, pending.id), eq(payments.status, 'PENDING')))
        .returning({ id: payments.id });
      if (replaced.length === 0) throw new ConflictException('Payment status changed, refresh the schedule');

      await tx.insert(payments).values({
        bookingId: pending.bookingId,
        orderId,
        amount: this.amount,
        currency: 'UAH',
        status: 'PENDING',
      });
    });
    this.logger.log(`Checkout: member=${memberId} slot=${slotId} — resumed booking=${pending.bookingId}, order ${pending.orderId} → REPLACED by ${orderId}`);
    return orderId;
  }

  private buildCheckout(orderId: string) {
    const params = {
      version: 3,
      public_key: this.publicKey,
      action: 'pay',
      amount: this.amount,
      currency: 'UAH',
      description: 'Персональне тренування Motion Gym',
      order_id: orderId,
      server_url: process.env.LIQPAY_SERVER_URL ?? '',
      result_url: `${process.env.FRONTEND_URL ?? ''}/payment/return?order=${orderId}`,
      // LiqPay closes the order at the same moment our expiry releases the booking,
      // so an old LiqPay tab can't be paid after the seat is gone. Format: UTC "YYYY-MM-DD HH:mm:ss"
      expired_date: new Date(Date.now() + this.expiryMs).toISOString().replace('T', ' ').slice(0, 19),
    };

    const data = liqpayEncode(params);
    const signature = liqpaySign(this.privateKey, data);

    return { data, signature };
  }

  async handleCallback(data: string, signature: string) {
    if (!liqpayVerify(this.privateKey, data, signature)) {
      this.logger.warn('LiqPay callback: invalid signature');
      return { ok: false };
    }

    const decoded = liqpayDecode(data);
    const orderId = decoded.order_id as string;

    this.logger.log(`LiqPay callback: ${this.describe(decoded)}`);

    const [payment] = await this.database.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .limit(1);

    if (!payment) return { ok: true };
    if (payment.status === 'PENDING') {
      await this.applyLiqpayStatus(payment, decoded);
      return { ok: true };
    }

    this.logger.log(`LiqPay callback: order=${orderId} ignored as PENDING handler — payment is already ${payment.status}`);
    if (SUCCESS_STATUSES.includes(decoded.status as string) && payment.status !== 'PAID') {
      // Member paid in an old LiqPay tab after pressing "Оплатити" again — still valid while the booking awaits payment
      if (payment.status === 'REPLACED' && (await this.isAwaitingPayment(payment.bookingId))) {
        await this.applyLiqpayStatus(payment, decoded);
      } else {
        this.logger.error(`LiqPay: order=${orderId} paid after it was ${payment.status} — needs manual handling`);
        // Keep the evidence (payment_id for a refund) in the DB — runtime logs expire in ~30 min.
        // Status stays as is; find these with: status <> 'PAID' AND raw_callback->>'status' IN ('success','sandbox')
        await this.database.db
          .update(payments)
          .set({ rawCallback: decoded, updatedAt: new Date() })
          .where(eq(payments.id, payment.id));
      }
    }
    return { ok: true };
  }

  // Used by /payment/return. Asks LiqPay directly while still PENDING, so the page
  // shows the real result even if the callback is late or lost.
  // errCode is set when LiqPay rejected an attempt but the order is still open (status=try_again);
  // expiresAt — when a still PENDING booking will be released
  async getStatus(
    orderId: string,
    memberId: string,
  ): Promise<{ status: PaymentStatus; errCode?: string; expiresAt?: string }> {
    const [payment] = await this.database.db
      .select({ id: payments.id, bookingId: payments.bookingId, status: payments.status, createdAt: payments.createdAt })
      .from(payments)
      .innerJoin(bookings, eq(bookings.id, payments.bookingId))
      .where(and(eq(payments.orderId, orderId), eq(bookings.memberId, memberId)))
      .limit(1);

    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== 'PENDING') {
      this.logger.log(`Status check: order=${orderId} → ${payment.status} (from DB)`);
      return { status: payment.status as PaymentStatus };
    }

    const expiresAt = new Date(payment.createdAt.getTime() + this.expiryMs).toISOString();
    const remote = await this.fetchLiqpayStatus(orderId);
    if (!remote || remote.result !== 'ok') {
      this.logger.log(`Status check: order=${orderId} → PENDING (LiqPay ${remote ? 'result=' + String(remote.result as string) : 'unreachable'})`);
      return { status: 'PENDING', expiresAt };
    }

    const status = await this.applyLiqpayStatus(payment, remote);
    const errCode = status === 'PENDING' && remote.status === 'try_again' && typeof remote.err_code === 'string'
      ? remote.err_code
      : undefined;
    this.logger.log(`Status check: order=${orderId} → ${status}${errCode ? ` errCode=${errCode}` : ''}`);
    if (status !== 'PENDING') return { status };
    return errCode ? { status, errCode, expiresAt } : { status, expiresAt };
  }

  async expireStale() {
    const cutoff = new Date(Date.now() - this.expiryMs);
    const stale = await this.database.db
      .select({ id: payments.id, bookingId: payments.bookingId, orderId: payments.orderId })
      .from(payments)
      .where(and(eq(payments.status, 'PENDING'), lt(payments.createdAt, cutoff)));

    let expired = 0;

    for (const p of stale) {
      // Reconcile before cancelling — the callback may have been lost while the member actually paid
      const remote = await this.fetchLiqpayStatus(p.orderId);
      if (!remote) {
        this.logger.warn(`Expire: order=${p.orderId} skipped — LiqPay unreachable, retry next run`);
        continue; // retry next run rather than cancel a possibly paid booking
      }
      if (remote.result === 'ok' && SUCCESS_STATUSES.includes(remote.status as string)) {
        this.logger.warn(`Expire: order=${p.orderId} was actually paid (lost callback) → PAID`);
        await this.applyLiqpayStatus(p, remote);
        continue;
      }

      if (await this.cancelPayment(p, 'EXPIRED')) {
        this.logger.log(`Expire: order=${p.orderId} → EXPIRED, booking=${p.bookingId} cancelled`);
        expired++;
      } else {
        this.logger.log(`Expire: order=${p.orderId} skipped — already handled by another request`);
      }
    }

    return { expired };
  }

  // Single place that maps a LiqPay status onto our payment + booking.
  // Non-final statuses (processing, *_verify, …) leave the payment PENDING.
  // Every transition is compare-and-set (UPDATE … WHERE status = expected RETURNING): concurrent requests
  // (callback retries, several clients triggering expireStale at once) can't apply the same transition twice.
  private async applyLiqpayStatus(
    payment: { id: string; bookingId: string },
    liqpay: Record<string, unknown>,
  ): Promise<PaymentStatus> {
    const status = liqpay.status as string;

    if (SUCCESS_STATUSES.includes(status)) {
      const liqpayPaymentId = liqpay.payment_id ? String(liqpay.payment_id) : null;
      const claimed = await this.database.db.transaction(async (tx) => {
        // REPLACED is allowed: the member may pay an old LiqPay tab (caller checks the booking still awaits payment)
        const [won] = await tx
          .update(payments)
          .set({ status: 'PAID', liqpayPaymentId, rawCallback: liqpay, updatedAt: new Date() })
          .where(and(eq(payments.id, payment.id), inArray(payments.status, ['PENDING', 'REPLACED'])))
          .returning({ id: payments.id });
        if (!won) return false;
        await tx
          .update(bookings)
          .set({ paymentStatus: 'PAID' })
          .where(eq(bookings.id, payment.bookingId));
        // Other open attempts for this booking must not expire it later
        await tx
          .update(payments)
          .set({ status: 'REPLACED', updatedAt: new Date() })
          .where(and(eq(payments.bookingId, payment.bookingId), eq(payments.status, 'PENDING'), ne(payments.id, payment.id)));
        return true;
      });
      return claimed ? 'PAID' : this.currentStatus(payment.id);
    }

    if (FAILED_STATUSES.includes(status)) {
      return (await this.cancelPayment(payment, 'FAILED', liqpay)) ? 'FAILED' : this.currentStatus(payment.id);
    }

    return 'PENDING';
  }

  // Someone else already moved the payment on — report what it is now
  private async currentStatus(paymentId: string): Promise<PaymentStatus> {
    const [row] = await this.database.db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);
    return (row?.status ?? 'PENDING') as PaymentStatus;
  }

  private async isAwaitingPayment(bookingId: string) {
    const [booking] = await this.database.db
      .select({ status: bookings.status, paymentStatus: bookings.paymentStatus })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .limit(1);
    return booking?.status === 'ACTIVE' && booking.paymentStatus === 'PENDING';
  }

  // Returns false when the payment was no longer PENDING (another request got there first) — then nothing changes.
  // The seat is released only if this call actually cancelled the booking, so bookedCount can't drop twice.
  private async cancelPayment(
    payment: { id: string; bookingId: string },
    status: 'FAILED' | 'EXPIRED',
    rawCallback?: Record<string, unknown>,
  ): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const [won] = await tx
        .update(payments)
        .set({ status, ...(rawCallback && { rawCallback }), updatedAt: new Date() })
        .where(and(eq(payments.id, payment.id), eq(payments.status, 'PENDING')))
        .returning({ id: payments.id });
      if (!won) return false;

      const [cancelled] = await tx
        .update(bookings)
        .set({ status: 'CANCELLED', cancelledAt: new Date() })
        .where(and(eq(bookings.id, payment.bookingId), eq(bookings.status, 'ACTIVE')))
        .returning({ slotId: bookings.slotId });
      if (cancelled?.slotId) {
        await tx
          .update(trainingSlots)
          .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - 1, 0)` })
          .where(eq(trainingSlots.id, cancelled.slotId));
      }
      return true;
    });
  }

  private async fetchLiqpayStatus(orderId: string): Promise<Record<string, unknown> | null> {
    try {
      const remote = await liqpayStatus(this.publicKey, this.privateKey, orderId);
      this.logger.log(`LiqPay status API: ${this.describe(remote)}`);
      return remote;
    } catch (err) {
      this.logger.warn(`LiqPay status API failed for order=${orderId}: ${(err as Error).message}`);
      return null;
    }
  }

  // Safe subset of a LiqPay payload (no names/phones/card masks) + the list of all keys,
  // so undocumented statuses and fields show up in logs
  private describe(liqpay: Record<string, unknown>) {
    const fields = LOGGED_LIQPAY_FIELDS.filter((key) => liqpay[key] != null)
      .map((key) => `${key}=${String(liqpay[key] as string)}`)
      .join(' ');
    return `${fields} keys=[${Object.keys(liqpay).sort().join(',')}]`;
  }
}
