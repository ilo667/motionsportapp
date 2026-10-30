import { Injectable, ConflictException, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { payments, purchases, purchaseItems } from '../database/schema';
import { ClockService } from '../clock/clock.service';
import { EntitlementsService } from '../purchases/entitlements.service';
import { liqpaySign, liqpayEncode, liqpayDecode, liqpayVerify, liqpayStatus } from './liqpay.helper';

const SUCCESS_STATUSES = ['success', 'sandbox'];
const FAILED_STATUSES = ['failure', 'error', 'reversed'];
// Per expireStale() run; the rest wait for the next schedule load
const EXPIRE_BATCH = 10;

// REPLACED: superseded by a newer checkout attempt for the same purchase
export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REPLACED';

const LOGGED_LIQPAY_FIELDS = [
  'result',
  'order_id',
  'status',
  'err_code',
  'err_description',
  'action',
  'paytype',
  'payment_id',
  'liqpay_order_id',
  'amount',
  'currency',
  'create_date',
  'end_date',
];

function newOrderId(purchaseId: string) {
  return `mg-${Date.now()}-${purchaseId.substring(0, 8)}`;
}

// Success hit a purchase no longer PENDING: roll back, money goes to manual handling
class PurchaseNotAwaitingPayment extends Error {}

// Also sent to LiqPay as expired_date, so both sides close the order together
const PAYMENT_EXPIRY_MS = 15 * 60 * 1000;

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private get publicKey() {
    return process.env.LIQPAY_PUBLIC_KEY ?? '';
  }
  private get privateKey() {
    return process.env.LIQPAY_PRIVATE_KEY ?? '';
  }

  // Amount is the purchase total fixed at purchase time. A retry continues the purchase with a new order id
  async checkoutPurchase(purchaseId: string, memberId: string) {
    if (!this.publicKey || !this.privateKey) {
      throw new BadRequestException('Payment is not configured');
    }

    const [purchase] = await this.database.db
      .select({ id: purchases.id, status: purchases.status, method: purchases.method, totalUah: purchases.totalUah })
      .from(purchases)
      .where(and(eq(purchases.id, purchaseId), eq(purchases.memberId, memberId)))
      .limit(1);
    if (!purchase || purchase.method !== 'LIQPAY') throw new NotFoundException('Purchase not found');
    if (purchase.status !== 'PENDING') throw new ConflictException('Purchase is no longer awaiting payment');

    const lines = await this.database.db
      .select({ title: purchaseItems.title, optionLabel: purchaseItems.optionLabel })
      .from(purchaseItems)
      .where(eq(purchaseItems.purchaseId, purchaseId));
    const description = `Motion Gym: ${lines.map((l) => (l.optionLabel ? `${l.title} · ${l.optionLabel}` : l.title)).join(' + ')}`;

    const resumed = await this.resumePendingCheckout(purchase.id, purchase.totalUah);
    if (resumed === 'PAID') {
      this.logger.log(
        `Checkout: member=${memberId} purchase=${purchaseId} — previous attempt already paid, no redirect`,
      );
      return { status: 'PAID' as const };
    }
    if (resumed === 'FAILED') throw new ConflictException('Payment failed, start a new purchase');
    if (resumed) return this.buildCheckout(resumed, purchase.totalUah, description);

    const orderId = newOrderId(purchase.id);
    await this.database.db
      .insert(payments)
      .values({ purchaseId: purchase.id, orderId, amount: purchase.totalUah, currency: 'UAH', status: 'PENDING' });

    this.logger.log(`Checkout: member=${memberId} purchase=${purchaseId} — new order=${orderId}`);
    return this.buildCheckout(orderId, purchase.totalUah, description);
  }

  // New order id replacing the PENDING payment, 'PAID' / 'FAILED' if LiqPay already settled the previous
  // attempt, null if nothing to resume. The literals are redundant in the type, kept as documentation
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  private async resumePendingCheckout(purchaseId: string, amount: number): Promise<string | 'PAID' | 'FAILED' | null> {
    const [pending] = await this.database.db
      .select({ id: payments.id, purchaseId: payments.purchaseId, orderId: payments.orderId })
      .from(payments)
      .where(and(eq(payments.purchaseId, purchaseId), eq(payments.status, 'PENDING')))
      .limit(1);

    if (!pending) return null;

    const remote = await this.fetchLiqpayStatus(pending.orderId);
    if (remote?.result === 'ok') {
      const applied = await this.applyLiqpayStatus(pending, remote);
      if (applied === 'PAID') return 'PAID';
      if (applied === 'FAILED') {
        this.logger.log(`Checkout: previous order=${pending.orderId} failed — purchase is over`);
        return 'FAILED';
      }
    }

    // LiqPay may refuse an order_id that already had an attempt
    const orderId = newOrderId(purchaseId);
    await this.database.db.transaction(async (tx) => {
      const replaced = await tx
        .update(payments)
        .set({ status: 'REPLACED', updatedAt: this.clock.now().toJSDate() })
        .where(and(eq(payments.id, pending.id), eq(payments.status, 'PENDING')))
        .returning({ id: payments.id });
      if (replaced.length === 0) throw new ConflictException('Payment status changed, refresh the page');

      await tx.insert(payments).values({ purchaseId, orderId, amount, currency: 'UAH', status: 'PENDING' });
    });
    this.logger.log(`Checkout: purchase=${purchaseId} — order ${pending.orderId} → REPLACED by ${orderId}`);
    return orderId;
  }

  private buildCheckout(orderId: string, amount: number, description: string) {
    const params = {
      version: 3,
      public_key: this.publicKey,
      action: 'pay',
      amount,
      currency: 'UAH',
      description,
      order_id: orderId,
      server_url: process.env.LIQPAY_SERVER_URL ?? '',
      result_url: `${process.env.FRONTEND_URL ?? ''}/payment/return?order=${orderId}`,
      // So an old LiqPay tab can't be paid after our expiry. UTC "YYYY-MM-DD HH:mm:ss"
      expired_date: new Date(this.clock.now().toMillis() + PAYMENT_EXPIRY_MS)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19),
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

    const [payment] = await this.database.db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);

    if (!payment) return { ok: true };
    if (payment.status === 'PENDING') {
      await this.applyLiqpayStatus(payment, decoded);
      return { ok: true };
    }

    this.logger.log(
      `LiqPay callback: order=${orderId} ignored as PENDING handler — payment is already ${payment.status}`,
    );
    if (SUCCESS_STATUSES.includes(decoded.status as string) && payment.status !== 'PAID') {
      // Paid in an old tab after a retry: still valid while the purchase is PENDING
      if (payment.status === 'REPLACED' && (await this.isAwaitingPayment(payment.purchaseId))) {
        await this.applyLiqpayStatus(payment, decoded);
      } else {
        await this.needsManualHandling(payment, decoded);
      }
    }
    // Refund: not handled in the app yet, keep the payload and leave the purchase as is
    if (decoded.status === 'reversed' && payment.status === 'PAID') {
      this.logger.warn(
        `LiqPay callback: order=${orderId} was refunded (reversed) — purchase left as is, needs manual handling`,
      );
      await this.database.db
        .update(payments)
        .set({ refundCallback: decoded, updatedAt: this.clock.now().toJSDate() })
        .where(eq(payments.id, payment.id));
    }
    return { ok: true };
  }

  // For /payment/return. While PENDING asks LiqPay directly, since the callback may be late or lost.
  // errCode: declined attempt on a still open order (try_again). booked: group pass bought for a slot
  async getStatus(
    orderId: string,
    memberId: string,
  ): Promise<{ status: PaymentStatus; errCode?: string; expiresAt?: string; booked?: boolean }> {
    const [payment] = await this.database.db
      .select({
        id: payments.id,
        purchaseId: payments.purchaseId,
        status: payments.status,
        createdAt: payments.createdAt,
        slotId: purchases.slotId,
        bookingId: purchases.bookingId,
      })
      .from(payments)
      .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
      .where(and(eq(payments.orderId, orderId), eq(purchases.memberId, memberId)))
      .limit(1);

    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== 'PENDING') {
      this.logger.log(`Status check: order=${orderId} → ${payment.status} (from DB)`);
      const status = payment.status as PaymentStatus;
      return status === 'PAID' && payment.slotId ? { status, booked: !!payment.bookingId } : { status };
    }

    const expiresAt = new Date(payment.createdAt.getTime() + PAYMENT_EXPIRY_MS).toISOString();
    const remote = await this.fetchLiqpayStatus(orderId);
    if (!remote || remote.result !== 'ok') {
      this.logger.log(
        `Status check: order=${orderId} → PENDING (LiqPay ${remote ? 'result=' + String(remote.result) : 'unreachable'})`,
      );
      return { status: 'PENDING', expiresAt };
    }

    const status = await this.applyLiqpayStatus(payment, remote);
    const errCode =
      status === 'PENDING' && remote.status === 'try_again' && typeof remote.err_code === 'string'
        ? remote.err_code
        : undefined;
    this.logger.log(`Status check: order=${orderId} → ${status}${errCode ? ` errCode=${errCode}` : ''}`);
    if (status === 'PAID' && payment.slotId) {
      // Booked in the same transaction as the payment
      const [after] = await this.database.db
        .select({ bookingId: purchases.bookingId })
        .from(purchases)
        .where(eq(purchases.id, payment.purchaseId))
        .limit(1);
      return { status, booked: !!after?.bookingId };
    }
    if (status !== 'PENDING') return { status };
    return errCode ? { status, errCode, expiresAt } : { status, expiresAt };
  }

  async expireStale() {
    const cutoff = new Date(this.clock.now().toMillis() - PAYMENT_EXPIRY_MS);
    const stale = await this.database.db
      .select({ id: payments.id, purchaseId: payments.purchaseId, orderId: payments.orderId })
      .from(payments)
      .where(and(eq(payments.status, 'PENDING'), lt(payments.createdAt, cutoff)))
      .limit(EXPIRE_BATCH);

    // Parallel: runs on every schedule load, so a slow LiqPay costs one timeout, not one per payment
    const results = await Promise.all(stale.map((p) => this.expireOne(p)));
    const expired = results.filter(Boolean).length;
    return { expired };
  }

  private async expireOne(p: { id: string; purchaseId: string; orderId: string }): Promise<boolean> {
    // The callback may have been lost while the member actually paid
    const remote = await this.fetchLiqpayStatus(p.orderId);
    if (!remote) {
      this.logger.warn(`Expire: order=${p.orderId} skipped — LiqPay unreachable, retry next run`);
      return false; // never cancel a possibly paid purchase
    }
    if (remote.result === 'ok' && SUCCESS_STATUSES.includes(remote.status as string)) {
      this.logger.warn(`Expire: order=${p.orderId} was actually paid (lost callback) → PAID`);
      await this.applyLiqpayStatus(p, remote);
      return false;
    }
    if (await this.cancelPayment(p, 'EXPIRED')) {
      this.logger.log(`Expire: order=${p.orderId} → EXPIRED, purchase=${p.purchaseId} expired`);
      return true;
    }
    this.logger.log(`Expire: order=${p.orderId} skipped — already handled by another request`);
    return false;
  }

  // The only place mapping a LiqPay status onto payment + purchase. Non-final statuses stay PENDING.
  // Compare-and-set transitions: callback retries and concurrent expireStale runs apply each once
  private async applyLiqpayStatus(
    payment: { id: string; purchaseId: string },
    liqpay: Record<string, unknown>,
  ): Promise<PaymentStatus> {
    const purchaseId = payment.purchaseId;
    const status = liqpay.status as string;

    if (SUCCESS_STATUSES.includes(status)) {
      // payment_id comes as a number
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const liqpayPaymentId = liqpay.payment_id ? String(liqpay.payment_id) : null;
      let claimed: boolean;
      try {
        claimed = await this.database.db.transaction(async (tx) => {
          // REPLACED: an old tab paid; the caller checked the purchase is still PENDING
          const [won] = await tx
            .update(payments)
            .set({ status: 'PAID', liqpayPaymentId, rawCallback: liqpay, updatedAt: this.clock.now().toJSDate() })
            .where(and(eq(payments.id, payment.id), inArray(payments.status, ['PENDING', 'REPLACED'])))
            .returning({ id: payments.id });
          if (!won) return false;
          const [paid] = await tx
            .update(purchases)
            .set({ status: 'PAID', decidedAt: this.clock.now().toJSDate() })
            .where(and(eq(purchases.id, purchaseId), eq(purchases.status, 'PENDING')))
            .returning({ id: purchases.id });
          if (!paid) throw new PurchaseNotAwaitingPayment();
          await this.entitlements.activate(tx, purchaseId);
          // So other open attempts can't expire it later
          await tx
            .update(payments)
            .set({ status: 'REPLACED', updatedAt: this.clock.now().toJSDate() })
            .where(
              and(eq(payments.purchaseId, purchaseId), eq(payments.status, 'PENDING'), ne(payments.id, payment.id)),
            );
          return true;
        });
      } catch (err) {
        if (!(err instanceof PurchaseNotAwaitingPayment)) throw err;
        await this.needsManualHandling({ id: payment.id, status: 'PENDING' }, liqpay);
        return this.currentStatus(payment.id);
      }
      return claimed ? 'PAID' : this.currentStatus(payment.id);
    }

    if (FAILED_STATUSES.includes(status)) {
      return (await this.cancelPayment(payment, 'FAILED', liqpay)) ? 'FAILED' : this.currentStatus(payment.id);
    }

    return 'PENDING';
  }

  private async currentStatus(paymentId: string): Promise<PaymentStatus> {
    const [row] = await this.database.db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);
    return (row?.status ?? 'PENDING') as PaymentStatus;
  }

  private async isAwaitingPayment(purchaseId: string) {
    const [purchase] = await this.database.db
      .select({ status: purchases.status })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .limit(1);
    return purchase?.status === 'PENDING';
  }

  // Money for a payment we can no longer apply (purchase cancelled, expired or already paid)
  private async needsManualHandling(payment: { id: string; status: string }, liqpay: Record<string, unknown>) {
    this.logger.error(
      `LiqPay: order=${String(liqpay.order_id)} paid after it was ${payment.status} — needs manual handling`,
    );
    // Kept in the DB (payment_id for a refund): Vercel logs last ~30 min. Status is left unchanged
    await this.saveRawCallback(payment.id, liqpay);
  }

  private async saveRawCallback(paymentId: string, liqpay: Record<string, unknown>) {
    await this.database.db
      .update(payments)
      .set({ rawCallback: liqpay, updatedAt: this.clock.now().toJSDate() })
      .where(eq(payments.id, paymentId));
  }

  // false: payment no longer PENDING, nothing changed. Purchase also compare-and-set
  private async cancelPayment(
    payment: { id: string; purchaseId: string },
    status: 'FAILED' | 'EXPIRED',
    rawCallback?: Record<string, unknown>,
  ): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const [won] = await tx
        .update(payments)
        .set({ status, ...(rawCallback && { rawCallback }), updatedAt: this.clock.now().toJSDate() })
        .where(and(eq(payments.id, payment.id), eq(payments.status, 'PENDING')))
        .returning({ id: payments.id });
      if (!won) return false;

      await tx
        .update(purchases)
        .set({ status, decidedAt: this.clock.now().toJSDate() })
        .where(and(eq(purchases.id, payment.purchaseId), eq(purchases.status, 'PENDING')));
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

  // Safe fields only (no names, phones, card masks) plus all keys, so undocumented fields show in logs
  private describe(liqpay: Record<string, unknown>) {
    const fields = LOGGED_LIQPAY_FIELDS.filter((key) => liqpay[key] != null)
      .map((key) => `${key}=${String(liqpay[key] as string)}`)
      .join(' ');
    return `${fields} keys=[${Object.keys(liqpay).sort().join(',')}]`;
  }
}
