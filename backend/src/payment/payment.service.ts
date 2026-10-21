import { Injectable, ConflictException, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { trainingSlots, bookings, payments } from '../database/schema';
import { liqpaySign, liqpayEncode, liqpayDecode, liqpayVerify } from './liqpay.helper';

const PAYMENT_TYPES = ['індивідуальні', 'спліт'];

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(private readonly database: DatabaseService) {}

  private get publicKey() { return process.env.LIQPAY_PUBLIC_KEY ?? ''; }
  private get privateKey() { return process.env.LIQPAY_PRIVATE_KEY ?? ''; }
  private get amount() { return parseInt(process.env.LIQPAY_AMOUNT ?? '700', 10); }

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

        const [existing] = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(
            and(
              eq(bookings.memberId, memberId),
              eq(bookings.trainingDayId, locked.trainingDayId),
              eq(bookings.status, 'ACTIVE'),
            ),
          )
          .limit(1);

        if (existing) throw new ConflictException('You already have an active booking for this day');

        const [inserted] = await tx
          .insert(bookings)
          .values({ memberId, trainingDayId: locked.trainingDayId, slotId, status: 'ACTIVE', paymentStatus: 'PENDING' })
          .returning({ id: bookings.id });

        orderId = `mg-${Date.now()}-${inserted.id.substring(0, 8)}`;

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
        throw new ConflictException('You already have an active booking for this day');
      }
      throw err;
    }

    const params = {
      version: 3,
      public_key: this.publicKey,
      action: 'pay',
      amount: this.amount,
      currency: 'UAH',
      description: 'Індивідуальне тренування Motion Gym',
      order_id: orderId,
      server_url: process.env.LIQPAY_SERVER_URL ?? '',
      result_url: `${process.env.FRONTEND_URL ?? ''}/payment/return?order=${orderId}`,
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
    const liqpayPaymentId = decoded.payment_id ? String(decoded.payment_id) : null;
    const status = decoded.status as string;

    this.logger.log(`LiqPay callback: order=${orderId} status=${status}`);

    const [payment] = await this.database.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .limit(1);

    if (!payment || payment.status !== 'PENDING') return { ok: true };

    const isSuccess = ['success', 'sandbox'].includes(status);
    const isFailed = ['failure', 'error', 'reversed'].includes(status);

    if (isSuccess) {
      await this.database.db.transaction(async (tx) => {
        await tx
          .update(payments)
          .set({ status: 'PAID', liqpayPaymentId, rawCallback: decoded, updatedAt: new Date() })
          .where(eq(payments.id, payment.id));
        await tx
          .update(bookings)
          .set({ paymentStatus: 'PAID' })
          .where(eq(bookings.id, payment.bookingId));
      });
    } else if (isFailed) {
      const [booking] = await this.database.db
        .select({ slotId: bookings.slotId })
        .from(bookings)
        .where(eq(bookings.id, payment.bookingId))
        .limit(1);

      await this.database.db.transaction(async (tx) => {
        await tx
          .update(payments)
          .set({ status: 'FAILED', rawCallback: decoded, updatedAt: new Date() })
          .where(eq(payments.id, payment.id));
        await tx
          .update(bookings)
          .set({ status: 'CANCELLED', cancelledAt: new Date() })
          .where(and(eq(bookings.id, payment.bookingId), eq(bookings.status, 'ACTIVE')));
        if (booking?.slotId) {
          await tx
            .update(trainingSlots)
            .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - 1, 0)` })
            .where(eq(trainingSlots.id, booking.slotId));
        }
      });
    }

    return { ok: true };
  }

  async expireStale() {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const stale = await this.database.db
      .select({ id: payments.id, bookingId: payments.bookingId })
      .from(payments)
      .where(and(eq(payments.status, 'PENDING'), lt(payments.createdAt, cutoff)));

    if (stale.length === 0) return { expired: 0 };

    for (const p of stale) {
      const [booking] = await this.database.db
        .select({ slotId: bookings.slotId })
        .from(bookings)
        .where(eq(bookings.id, p.bookingId))
        .limit(1);

      await this.database.db.transaction(async (tx) => {
        await tx
          .update(payments)
          .set({ status: 'EXPIRED', updatedAt: new Date() })
          .where(eq(payments.id, p.id));
        await tx
          .update(bookings)
          .set({ status: 'CANCELLED', cancelledAt: new Date() })
          .where(and(eq(bookings.id, p.bookingId), eq(bookings.status, 'ACTIVE')));
        if (booking?.slotId) {
          await tx
            .update(trainingSlots)
            .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - 1, 0)` })
            .where(eq(trainingSlots.id, booking.slotId));
        }
      });
    }

    return { expired: stale.length };
  }
}
