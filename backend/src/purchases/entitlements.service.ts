import { Injectable, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DatabaseService } from '../database/database.service';
import { ClockService } from '../clock/clock.service';
import {
  attendance,
  bookings,
  clubCards,
  freezeItems,
  packages,
  packageSpends,
  priceItems,
  purchaseItems,
  purchases,
  trainingDays,
  trainingSlots,
} from '../database/schema';
import { GROUP_TYPE, KY_ZONE, PASS_TYPES } from '../schedule/training-types';
import { tryBookGroup } from '../booking/group-booking';
import { activateByFor, cardState, passState, PassState, passUsableOn, validUntilFor } from './validity';
import { loadFreezes } from '../freezes/freeze.store';
import { daysBetween, frozenOn, plusDays } from '../freezes/rules';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Q = Db | Tx;

// Batch marks lock members' packages (syncSpend); a fixed order stops two batches deadlocking
export function inLockOrder<T extends { id: string; memberId: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.memberId.localeCompare(b.memberId) || a.id.localeCompare(b.id));
}

export type PackageView = {
  id: string;
  trainingType: 'group' | 'personal' | 'split';
  title: string;
  total: number;
  left: number;
  state: PassState;
  purchasedOn: string;
  activateBy: string;
  activatedOn: string | null;
  validUntil: string | null;
  createdAt: string;
};

export type UsableCard = {
  id: string;
  label: string;
  state: 'waiting' | 'active';
  validUntil: string | null;
  activateBy: string;
};

// Fully qualified: drizzle drops table names in single-table selects
export const USED = sql<number>`(select count(*)::int from package_spends ps where ps.package_id = "packages"."id")`;

const cardLabel = (title: string, optionLabel: string | null) => (optionLabel ? `${title} · ${optionLabel}` : title);

// Active card lasting longest, else the waiting one that burns first; burned / expired ignored
function pickCard<T extends { activateBy: string; validFrom: string | null; validUntil: string | null }>(
  cards: T[],
  today: string,
): (T & { state: 'waiting' | 'active' }) | null {
  const withState = cards.map((c) => ({ ...c, state: cardState(c, today) }));
  const active = withState
    .filter((c) => c.state === 'active')
    .sort((a, b) => b.validUntil!.localeCompare(a.validUntil!));
  if (active.length) return active[0] as T & { state: 'active' };
  const waiting = withState
    .filter((c) => c.state === 'waiting')
    .sort((a, b) => a.activateBy.localeCompare(b.activateBy));
  return waiting.length ? (waiting[0] as T & { state: 'waiting' }) : null;
}

const CARD_COLUMNS = {
  id: clubCards.id,
  label: clubCards.label,
  activateBy: clubCards.activateBy,
  validFrom: clubCards.validFrom,
  validUntil: clubCards.validUntil,
};

const PASS_DATES = {
  purchasedOn: packages.purchasedOn,
  activateBy: packages.activateBy,
  activatedOn: packages.activatedOn,
  validUntil: packages.validUntil,
};

// Club cards and packages. Nothing starts on payment: a card waits for trainer activation, a package
// for its first attendance mark; not activated within a month, it burns (validity.ts)
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
  ) {}

  private today() {
    return this.clock.now().toISODate()!;
  }

  // Runs in the transaction that marks the purchase PAID. A group pass bought for a slot also books it
  async activate(tx: Tx, purchaseId: string) {
    const lines = await tx
      .select({
        id: purchaseItems.id,
        memberId: purchases.memberId,
        createdAt: purchases.createdAt,
        title: purchaseItems.title,
        optionLabel: purchaseItems.optionLabel,
        section: priceItems.section,
        durationMonths: priceItems.durationMonths,
        trainingType: priceItems.trainingType,
        trainingCount: priceItems.trainingCount,
      })
      .from(purchaseItems)
      .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
      .innerJoin(priceItems, eq(priceItems.id, purchaseItems.priceItemId))
      .where(eq(purchaseItems.purchaseId, purchaseId));

    for (const line of lines) {
      // Day of purchase, not of payment confirmation
      const purchasedOn = DateTime.fromJSDate(line.createdAt, { zone: KY_ZONE }).toISODate()!;
      if (line.section === 'club_card') {
        await tx.insert(clubCards).values({
          memberId: line.memberId,
          purchaseItemId: line.id,
          label: cardLabel(line.title, line.optionLabel),
          validFrom: null,
          validUntil: null,
          durationMonths: line.durationMonths ?? 0,
          activateBy: activateByFor(purchasedOn),
        });
      } else if (line.trainingType && line.trainingCount) {
        await tx.insert(packages).values({
          memberId: line.memberId,
          purchaseItemId: line.id,
          trainingType: line.trainingType,
          total: line.trainingCount,
          durationMonths: line.durationMonths ?? 1,
          purchasedOn,
          activateBy: activateByFor(purchasedOn),
        });
      }
    }

    const [purchase] = await tx
      .select({ memberId: purchases.memberId, slotId: purchases.slotId, bookingId: purchases.bookingId })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .limit(1);
    if (!purchase?.slotId) return;
    let bookingId = purchase.bookingId;
    if (!bookingId) {
      // LiqPay: book now. If that fails the pass stays; never fail the payment
      const booked = await tryBookGroup(tx, this.clock.now(), purchase.memberId, purchase.slotId);
      if (!booked.ok) {
        this.logger.log(`Purchase ${purchaseId}: paid, not booked (${booked.reason})`);
        return;
      }
      bookingId = booked.bookingId;
      await tx.update(purchases).set({ bookingId }).where(eq(purchases.id, purchaseId));
    }
    // Cash confirmed after the training was already marked
    await this.syncSpend(tx, bookingId);
  }

  // Waiting or active; a waiting card is enough to buy a trainer service
  async usableCard(memberId: string, db: Q = this.database.db): Promise<UsableCard | null> {
    const cards = await db.select(CARD_COLUMNS).from(clubCards).where(eq(clubCards.memberId, memberId));
    const card = pickCard(cards, this.today());
    return card
      ? { id: card.id, label: card.label, state: card.state, validUntil: card.validUntil, activateBy: card.activateBy }
      : null;
  }

  // Oldest first: spend order
  async packagesOf(memberId: string, db: Q = this.database.db): Promise<PackageView[]> {
    const rows = await db
      .select({
        id: packages.id,
        trainingType: packages.trainingType,
        title: purchaseItems.title,
        total: packages.total,
        used: USED,
        ...PASS_DATES,
        createdAt: packages.createdAt,
      })
      .from(packages)
      .innerJoin(purchaseItems, eq(purchaseItems.id, packages.purchaseItemId))
      .where(eq(packages.memberId, memberId))
      .orderBy(asc(packages.createdAt));
    const today = this.today();
    return rows.map(({ used, ...r }) => ({
      ...r,
      trainingType: r.trainingType as PackageView['trainingType'],
      left: r.total - used,
      state: passState({ ...r, left: r.total - used }, today),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async summaries(memberIds: string[], db: Q = this.database.db) {
    const result = new Map<
      string,
      {
        clubCard: { state: 'waiting' | 'active'; until: string } | null;
        packagesLeft: { trainingType: string; left: number }[];
      }
    >();
    if (memberIds.length === 0) return result;
    const cards = await db
      .select({ memberId: clubCards.memberId, ...CARD_COLUMNS })
      .from(clubCards)
      .where(inArray(clubCards.memberId, memberIds));
    const packs = await db
      .select({
        memberId: packages.memberId,
        trainingType: packages.trainingType,
        total: packages.total,
        used: USED,
        ...PASS_DATES,
      })
      .from(packages)
      .where(inArray(packages.memberId, memberIds));

    const today = this.today();
    for (const id of memberIds) {
      const card = pickCard(
        cards.filter((c) => c.memberId === id),
        today,
      );
      const left = new Map<string, number>();
      for (const p of packs.filter((p) => p.memberId === id)) {
        const state = passState({ ...p, left: p.total - p.used }, today);
        if (state === 'waiting' || state === 'active') {
          left.set(p.trainingType, (left.get(p.trainingType) ?? 0) + p.total - p.used);
        }
      }
      result.set(id, {
        clubCard: card
          ? { state: card.state, until: card.state === 'active' ? card.validUntil! : card.activateBy }
          : null,
        packagesLeft: [...left].map(([trainingType, n]) => ({ trainingType, left: n })),
      });
    }
    return result;
  }

  async groupPassLeft(memberId: string, date: string, db: Q = this.database.db) {
    const rows = await db
      .select({ total: packages.total, used: USED, ...PASS_DATES })
      .from(packages)
      .where(and(eq(packages.memberId, memberId), eq(packages.trainingType, GROUP_TYPE)));
    return rows.filter((p) => passUsableOn(p, date)).reduce((sum, p) => sum + Math.max(p.total - p.used, 0), 0);
  }

  // Any mark (present or absent) spends one training (see payerFor); the first spend activates the package.
  // Clearing the mark returns it to the same package, activation stays. No package left: no spend, no debt
  async syncSpend(tx: Tx, bookingId: string) {
    const [booking] = await tx
      .select({
        memberId: bookings.memberId,
        trainingType: trainingSlots.trainingType,
        localDate: trainingDays.localDate,
        marked: attendance.bookingId,
        spentFrom: packageSpends.packageId,
        status: bookings.status,
        cancelFee: bookings.cancelFee,
        feeWaivedAt: bookings.feeWaivedAt,
      })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
      .leftJoin(packageSpends, eq(packageSpends.bookingId, bookings.id))
      .where(eq(bookings.id, bookingId))
      .limit(1);
    if (!booking || !PASS_TYPES.includes(booking.trainingType)) return;

    // A late-cancellation fee spends too, unless waived (booking/cancel-fee.ts)
    const lateCancel = booking.status === 'CANCELLED' && !!booking.cancelFee && !booking.feeWaivedAt;
    if (!booking.marked && !lateCancel) {
      if (booking.spentFrom) await tx.delete(packageSpends).where(eq(packageSpends.bookingId, bookingId));
      return;
    }
    if (booking.spentFrom) return;
    // Freeze cancels those bookings; this catches any left over
    const memberFreezes = await loadFreezes(tx, [booking.memberId]);
    if (memberFreezes.some((f) => frozenOn(f, booking.localDate))) return;

    const from = await this.payerFor(tx, booking, bookingId, true);
    if (!from) return;

    await tx.insert(packageSpends).values({ bookingId, packageId: from.id }).onConflictDoNothing();
    if (!from.activatedOn) {
      // Mark dated before a freeze (edited in history): the package was waiting then, so its validity also
      // skips the frozen days and is recorded for an early unfreeze
      let validUntil = validUntilFor(booking.localDate, from.durationMonths);
      const later = memberFreezes.filter((f) => f.status === 'ACTIVE' && f.startedOn! >= booking.localDate);
      for (const f of later) {
        if (f.startedOn! > validUntil) continue;
        validUntil = plusDays(validUntil, daysBetween(f.startedOn!, f.endsOn!));
        await tx.insert(freezeItems).values({ freezeId: f.id, packageId: from.id, field: 'valid_until' });
      }
      await tx
        .update(packages)
        .set({ activatedOn: booking.localDate, validUntil })
        .where(and(eq(packages.id, from.id), isNull(packages.activatedOn)));
    }
  }

  // The package bought for this booking, else the oldest usable one with trainings left; null if none.
  // lock: lock first, count in a second statement (fresh READ COMMITTED snapshot), else two marks can both
  // take the last training. Lock packages only: payments lock purchase then packages, the reverse deadlocks
  async payerFor(
    q: Q,
    booking: { memberId: string; trainingType: string; localDate: string },
    bookingId: string,
    lock = false,
  ) {
    const query = q
      .select({
        id: packages.id,
        total: packages.total,
        durationMonths: packages.durationMonths,
        ...PASS_DATES,
        forBooking: sql<boolean>`coalesce(${purchases.bookingId} = ${bookingId}, false)`,
        // For the half refund on a late-cancelled single training
        amountUah: purchaseItems.amountUah,
        purchaseId: purchases.id,
      })
      .from(packages)
      .innerJoin(purchaseItems, eq(purchaseItems.id, packages.purchaseItemId))
      .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
      .where(and(eq(packages.memberId, booking.memberId), eq(packages.trainingType, booking.trainingType)))
      .orderBy(asc(packages.createdAt));
    const own = lock ? await query.for('update', { of: packages }) : await query;
    if (own.length === 0) return null;
    const spent = await q
      .select({ packageId: packageSpends.packageId, used: sql<number>`count(*)::int` })
      .from(packageSpends)
      .where(
        inArray(
          packageSpends.packageId,
          own.map((p) => p.id),
        ),
      )
      .groupBy(packageSpends.packageId);
    const usable = own.filter(
      (p) => passUsableOn(p, booking.localDate) && (spent.find((x) => x.packageId === p.id)?.used ?? 0) < p.total,
    );
    return usable.find((p) => p.forBooking) ?? usable[0] ?? null;
  }

  // «Активувати з сьогодні». Compare-and-set: burned or active cards are left alone
  async activateCard(db: Q, memberId: string, cardId: string) {
    const today = this.today();
    const mine = and(eq(clubCards.id, cardId), eq(clubCards.memberId, memberId));
    const [done] = await db
      .update(clubCards)
      .set({
        validFrom: today,
        // Matches validity.ts: Postgres also clamps to the month's last day
        validUntil: sql`(${today}::date + make_interval(months => ${clubCards.durationMonths}))::date`,
      })
      .where(and(mine, isNull(clubCards.validFrom), gte(clubCards.activateBy, today)))
      .returning({ id: clubCards.id });
    if (done) return;
    const [exists] = await db.select({ id: clubCards.id }).from(clubCards).where(mine).limit(1);
    if (!exists) throw new NotFoundException('Card not found');
    throw new ConflictException('Card cannot be activated');
  }

  // Card bought at the reception, added by the trainer
  async addManualCard(db: Q, memberId: string, trainerId: string, priceItemId: string, activateNow: boolean) {
    const [item] = await db
      .select({
        section: priceItems.section,
        title: priceItems.title,
        optionLabel: priceItems.optionLabel,
        durationMonths: priceItems.durationMonths,
      })
      .from(priceItems)
      .where(eq(priceItems.id, priceItemId))
      .limit(1);
    if (!item) throw new NotFoundException('Price not found');
    if (item.section !== 'club_card') throw new BadRequestException('Not a club card');

    const today = this.today();
    const months = item.durationMonths ?? 0;
    await db.insert(clubCards).values({
      memberId,
      purchaseItemId: null,
      label: cardLabel(item.title, item.optionLabel),
      validFrom: activateNow ? today : null,
      validUntil: activateNow ? validUntilFor(today, months) : null,
      durationMonths: months,
      activateBy: activateByFor(today),
      addedBy: trainerId,
    });
  }
}
