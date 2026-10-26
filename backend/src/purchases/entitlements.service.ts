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

// The order a batch of marks («Підтвердити всіх», the 22:00 cron) goes through its bookings. syncSpend locks the
// member's packages, so two batches over the same members must take them in the same order: otherwise each holds
// a member the other waits for, Postgres breaks the deadlock and rolls back a whole batch
export function inLockOrder<T extends { id: string; memberId: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.memberId.localeCompare(b.memberId) || a.id.localeCompare(b.id));
}

export type PackageView = {
  id: string;
  trainingType: 'групові' | 'персональні' | 'спліт';
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

// Trainings already spent from a package. Fully qualified: drizzle drops table names in single-table selects
const USED = sql<number>`(select count(*)::int from package_spends ps where ps.package_id = "packages"."id")`;

const cardLabel = (title: string, optionLabel: string | null) => (optionLabel ? `${title} · ${optionLabel}` : title);

// The card a member has: the active one that lasts longest, else the waiting one that burns first.
// Burned and expired cards don't count
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

// What a member has paid for: club cards (access to the gym) and packages (trainer services, group passes).
// Nothing starts on payment: a card waits for the trainer's «Активувати з сьогодні», a package for its first mark;
// not activated within a month of the purchase, it burns (validity.ts)
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

  // A paid purchase turns into a club card and / or a package. Called in the transaction that marks it PAID.
  // A group pass bought from «Записатися» then books its slot (LiqPay) and pays for that booking
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
      // The day it was bought, not the day the payment was confirmed
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
      // Paid by LiqPay: book now. Can't (window closed, slot full) → the pass stays, never fail the payment
      const booked = await tryBookGroup(tx, this.clock.now(), purchase.memberId, purchase.slotId);
      if (!booked.ok) {
        this.logger.log(`Purchase ${purchaseId}: paid, not booked (${booked.reason})`);
        return;
      }
      bookingId = booked.bookingId;
      await tx.update(purchases).set({ bookingId }).where(eq(purchases.id, purchaseId));
    }
    // Already marked (cash confirmed after the training): spend from this pass now
    await this.syncSpend(tx, bookingId);
  }

  // The card the member has now, waiting or active (a waiting card counts when buying a trainer service)
  async usableCard(memberId: string, db: Q = this.database.db): Promise<UsableCard | null> {
    const cards = await db.select(CARD_COLUMNS).from(clubCards).where(eq(clubCards.memberId, memberId));
    const card = pickCard(cards, this.today());
    return card
      ? { id: card.id, label: card.label, state: card.state, validUntil: card.validUntil, activateBy: card.activateBy }
      : null;
  }

  // Oldest first, the order trainings are spent in
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

  // Clients list: per member, the card (waiting until / active until) and trainings left by type, counting only
  // packages that can still be used
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

  // Group trainings the member's passes can still pay for on that date (booking a group training needs one)
  async groupPassLeft(memberId: string, date: string, db: Q = this.database.db) {
    const rows = await db
      .select({ total: packages.total, used: USED, ...PASS_DATES })
      .from(packages)
      .where(and(eq(packages.memberId, memberId), eq(packages.trainingType, GROUP_TYPE)));
    return rows.filter((p) => passUsableOn(p, date)).reduce((sum, p) => sum + Math.max(p.total - p.used, 0), 0);
  }

  // Keeps the packages in step with the attendance mark of one booking: any mark (✓ or ✗) spends one training
  // from a package of that type usable on the training's date: the one bought for this booking first (cash for a
  // group training), then the oldest. The first spend activates the package from that date. «—» gives the
  // training back to the package it came from; the activation stays. No package left: nothing is spent, no debt
  async syncSpend(tx: Tx, bookingId: string) {
    const [booking] = await tx
      .select({
        memberId: bookings.memberId,
        trainingType: trainingSlots.trainingType,
        localDate: trainingDays.localDate,
        marked: attendance.bookingId,
        spentFrom: packageSpends.packageId,
      })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
      .leftJoin(packageSpends, eq(packageSpends.bookingId, bookings.id))
      .where(eq(bookings.id, bookingId))
      .limit(1);
    if (!booking || !PASS_TYPES.includes(booking.trainingType)) return;

    if (!booking.marked) {
      if (booking.spentFrom) await tx.delete(packageSpends).where(eq(packageSpends.bookingId, bookingId));
      return;
    }
    if (booking.spentFrom) return;
    // Nothing is spent on a frozen day (the freeze cancels those bookings; this is for any left over)
    const memberFreezes = await loadFreezes(tx, [booking.memberId]);
    if (memberFreezes.some((f) => frozenOn(f, booking.localDate))) return;

    // Lock first, count after: a mark waiting on the lock must see the other mark's spend. A count inside the
    // locking statement would use that statement's snapshot, taken before the wait, and both could take the
    // last training. The second statement gets a fresh snapshot (READ COMMITTED). Only the packages are locked
    // (`of`), not the joined purchase: payments lock the purchase before the packages, the other order deadlocks
    const own = await tx
      .select({
        id: packages.id,
        total: packages.total,
        durationMonths: packages.durationMonths,
        ...PASS_DATES,
        forBooking: sql<boolean>`coalesce(${purchases.bookingId} = ${bookingId}, false)`,
      })
      .from(packages)
      .innerJoin(purchaseItems, eq(purchaseItems.id, packages.purchaseItemId))
      .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
      .where(and(eq(packages.memberId, booking.memberId), eq(packages.trainingType, booking.trainingType)))
      .orderBy(asc(packages.createdAt))
      .for('update', { of: packages });
    if (own.length === 0) return;
    const spent = await tx
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
    const from = usable.find((p) => p.forBooking) ?? usable[0];
    if (!from) return;

    await tx.insert(packageSpends).values({ bookingId, packageId: from.id }).onConflictDoNothing();
    if (!from.activatedOn) {
      // Activated by a mark from before a freeze (a fix in «Історія»): it was waiting when the freeze started, so
      // its month also skips the frozen days, and an early unfreeze moves it back like the rest
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

  // «Активувати з сьогодні»: a waiting card starts today for its months. Compare-and-set, so a burned or already
  // active card is left alone
  async activateCard(db: Q, memberId: string, cardId: string) {
    const today = this.today();
    const mine = and(eq(clubCards.id, cardId), eq(clubCards.memberId, memberId));
    const [done] = await db
      .update(clubCards)
      .set({
        validFrom: today,
        // Same month arithmetic as validity.ts: Postgres also clamps to the month's last day
        validUntil: sql`(${today}::date + make_interval(months => ${clubCards.durationMonths}))::date`,
      })
      .where(and(mine, isNull(clubCards.validFrom), gte(clubCards.activateBy, today)))
      .returning({ id: clubCards.id });
    if (done) return;
    const [exists] = await db.select({ id: clubCards.id }).from(clubCards).where(mine).limit(1);
    if (!exists) throw new NotFoundException('Card not found');
    throw new ConflictException('Card cannot be activated');
  }

  // A card bought at the reception: the trainer adds it, waiting for activation or active from today
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
