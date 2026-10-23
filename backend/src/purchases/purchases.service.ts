import { Injectable, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { ClockService } from '../clock/clock.service';
import { admins, clubCards, members, payments, priceItems, purchaseItems, purchases } from '../database/schema';
import { EntitlementsService } from './entitlements.service';
import { PaymentService } from '../payment/payment.service';
import { NotificationService } from '../notifications/notification.service';
import type { CreatePurchaseDto } from './dto/create-purchase.dto';

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
  lines: { title: string; optionLabel: string | null; amountUah: number }[];
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
      .where(inArray(priceItems.section, ['club_card', 'assigned']))
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

    return {
      catalog: {
        clubCards: catalog.filter((c) => c.section === 'club_card'),
        services: catalog.filter((c) => c.section === 'assigned'),
      },
      card: await this.entitlements.activeCard(memberId),
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
      })
      .from(priceItems)
      .where(inArray(priceItems.id, ids));
    if (items.length !== ids.length) throw new NotFoundException('Price not found');
    if (items.some((i) => i.section === 'group')) throw new BadRequestException('Group trainings are free');

    const services = items.filter((i) => i.section === 'assigned');
    const cards = items.filter((i) => i.section === 'club_card');
    if (services.length !== 1 || cards.length > 1) {
      throw new BadRequestException('Buy one trainer service, with at most one club card');
    }
    if (cards.length === 0 && !(await this.entitlements.activeCard(memberId))) {
      throw new BadRequestException('Club card required');
    }

    // The club card goes first, as on the page
    const lines = [...cards, ...services];
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
        .values({ memberId, trainerId: member.trainerId, method: dto.method, status: 'PENDING', totalUah })
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

  // The member never paid
  async rejectCash(trainerId: string, purchaseId: string) {
    await this.database.db.transaction((tx) => this.decideCash(tx, trainerId, purchaseId, 'REJECTED'));
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
      .returning({ id: purchases.id });
    if (decided) return;
    const [exists] = await tx.select({ status: purchases.status }).from(purchases).where(mine).limit(1);
    if (!exists) throw new NotFoundException('Purchase not found');
    throw new ConflictException('Purchase was already decided');
  }

  // A client's page: cards, packages and purchase history
  async memberPurchases(trainerId: string, memberId: string) {
    await this.visibleMember(trainerId, memberId);
    const cards = await this.database.db
      .select({
        label: clubCards.label,
        validFrom: clubCards.validFrom,
        validUntil: clubCards.validUntil,
        purchaseItemId: clubCards.purchaseItemId,
      })
      .from(clubCards)
      .where(eq(clubCards.memberId, memberId))
      .orderBy(desc(clubCards.validUntil));
    const history = await this.database.db
      .select({ id: purchases.id, decidedBy: admins.username })
      .from(purchases)
      .leftJoin(admins, eq(admins.id, purchases.decidedBy))
      .where(eq(purchases.memberId, memberId))
      .orderBy(desc(purchases.createdAt))
      .limit(MEMBER_PURCHASES_LIMIT);
    const views = await this.views(history.map((h) => h.id));

    return {
      card: await this.entitlements.activeCard(memberId),
      cards: cards.map(({ purchaseItemId, ...c }) => ({ ...c, source: purchaseItemId ? 'purchase' : 'manual' })),
      packages: await this.entitlements.packagesOf(memberId),
      purchases: views.map((v) => ({ ...v, decidedBy: history.find((h) => h.id === v.id)?.decidedBy ?? null })),
    };
  }

  // «Додати карту вручну»: a card bought at the reception
  async addCard(trainerId: string, memberId: string, priceItemId: string) {
    await this.visibleMember(trainerId, memberId);
    await this.entitlements.addManualCard(this.database.db, memberId, trainerId, priceItemId);
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
        title: purchaseItems.title,
        optionLabel: purchaseItems.optionLabel,
        amountUah: purchaseItems.amountUah,
      })
      .from(purchaseItems)
      .where(inArray(purchaseItems.purchaseId, ids));
    return ids
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is (typeof rows)[number] => !!r)
      .map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        lines: lines
          .filter((l) => l.purchaseId === r.id)
          .map((l) => ({ title: l.title, optionLabel: l.optionLabel, amountUah: l.amountUah })),
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
