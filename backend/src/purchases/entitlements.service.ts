import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, max, sql } from 'drizzle-orm';
import type { DateTime } from 'luxon';
import { DatabaseService } from '../database/database.service';
import { ClockService } from '../clock/clock.service';
import {
  attendance,
  bookings,
  clubCards,
  packages,
  packageSpends,
  priceItems,
  purchaseItems,
  purchases,
  trainingSlots,
} from '../database/schema';
import { isAssignedType } from '../schedule/training-types';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Q = Db | Tx;

export type PackageView = {
  id: string;
  trainingType: 'персональні' | 'спліт';
  title: string;
  total: number;
  left: number;
  createdAt: string;
};

// Trainings already spent from a package. Fully qualified: drizzle drops table names in single-table selects
const USED = sql<number>`(select count(*)::int from package_spends ps where ps.package_id = "packages"."id")`;

const cardLabel = (title: string, optionLabel: string | null) => (optionLabel ? `${title} · ${optionLabel}` : title);

// What a member has paid for: club cards (access to the gym) and packages of trainings with the trainer
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
  ) {}

  // A paid purchase turns into a club card and / or a package. Called in the transaction that marks it PAID
  async activate(tx: Q, purchaseId: string) {
    const lines = await tx
      .select({
        id: purchaseItems.id,
        memberId: purchases.memberId,
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

    const today = this.clock.now().startOf('day');
    for (const line of lines) {
      if (line.section === 'club_card') {
        await tx.insert(clubCards).values({
          memberId: line.memberId,
          purchaseItemId: line.id,
          label: cardLabel(line.title, line.optionLabel),
          ...this.cardDates(today, line.durationMonths ?? 0),
        });
      } else if (line.section === 'assigned' && line.trainingType && line.trainingCount) {
        await tx.insert(packages).values({
          memberId: line.memberId,
          purchaseItemId: line.id,
          trainingType: line.trainingType,
          total: line.trainingCount,
        });
      }
    }
  }

  // The card that lasts longest among the ones still valid today
  async activeCard(memberId: string, db: Q = this.database.db) {
    const [card] = await db
      .select({ id: clubCards.id, label: clubCards.label, validUntil: clubCards.validUntil })
      .from(clubCards)
      .where(and(eq(clubCards.memberId, memberId), gte(clubCards.validUntil, this.clock.now().toISODate()!)))
      .orderBy(desc(clubCards.validUntil))
      .limit(1);
    return card ?? null;
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
        createdAt: packages.createdAt,
      })
      .from(packages)
      .innerJoin(purchaseItems, eq(purchaseItems.id, packages.purchaseItemId))
      .where(eq(packages.memberId, memberId))
      .orderBy(asc(packages.createdAt));
    return rows.map((r) => ({
      id: r.id,
      trainingType: r.trainingType as PackageView['trainingType'],
      title: r.title,
      total: r.total,
      left: r.total - r.used,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // Clients list: per member, until when the card lasts and how many trainings are left by type (only types with some)
  async summaries(memberIds: string[], db: Q = this.database.db) {
    const result = new Map<
      string,
      { clubCardUntil: string | null; packagesLeft: { trainingType: string; left: number }[] }
    >();
    if (memberIds.length === 0) return result;
    const cards = await db
      .select({ memberId: clubCards.memberId, until: max(clubCards.validUntil) })
      .from(clubCards)
      .where(and(inArray(clubCards.memberId, memberIds), gte(clubCards.validUntil, this.clock.now().toISODate()!)))
      .groupBy(clubCards.memberId);
    const packs = await db
      .select({ memberId: packages.memberId, trainingType: packages.trainingType, total: packages.total, used: USED })
      .from(packages)
      .where(inArray(packages.memberId, memberIds));

    for (const id of memberIds) {
      const left = new Map<string, number>();
      for (const p of packs.filter((p) => p.memberId === id)) {
        left.set(p.trainingType, (left.get(p.trainingType) ?? 0) + p.total - p.used);
      }
      result.set(id, {
        clubCardUntil: cards.find((c) => c.memberId === id)?.until ?? null,
        packagesLeft: [...left].filter(([, n]) => n > 0).map(([trainingType, n]) => ({ trainingType, left: n })),
      });
    }
    return result;
  }

  // Keeps the package in step with the attendance mark of one booking: any mark (✓ or ✗) on a personal / split
  // training spends one training from the oldest package of that type with trainings left; «—» gives it back
  // to the package it came from. No package left: the mark stands and nothing is spent
  async syncSpend(tx: Tx, bookingId: string) {
    const [booking] = await tx
      .select({
        memberId: bookings.memberId,
        trainingType: trainingSlots.trainingType,
        marked: attendance.bookingId,
        spentFrom: packageSpends.packageId,
      })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
      .leftJoin(packageSpends, eq(packageSpends.bookingId, bookings.id))
      .where(eq(bookings.id, bookingId))
      .limit(1);
    if (!booking || !isAssignedType(booking.trainingType)) return;

    if (!booking.marked) {
      if (booking.spentFrom) await tx.delete(packageSpends).where(eq(packageSpends.bookingId, bookingId));
      return;
    }
    if (booking.spentFrom) return;

    // Locked, so two marks at once can't both spend the last training of a package
    const own = await tx
      .select({ id: packages.id, total: packages.total, used: USED })
      .from(packages)
      .where(and(eq(packages.memberId, booking.memberId), eq(packages.trainingType, booking.trainingType)))
      .orderBy(asc(packages.createdAt))
      .for('update');
    const from = own.find((p) => p.used < p.total);
    if (!from) return;

    await tx.insert(packageSpends).values({ bookingId, packageId: from.id }).onConflictDoNothing();
  }

  // A card bought at the reception, before the app: the trainer adds it, valid from today
  async addManualCard(db: Q, memberId: string, trainerId: string, priceItemId: string) {
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

    await db.insert(clubCards).values({
      memberId,
      purchaseItemId: null,
      label: cardLabel(item.title, item.optionLabel),
      ...this.cardDates(this.clock.now().startOf('day'), item.durationMonths ?? 0),
      addedBy: trainerId,
    });
  }

  // «1 місяць» = until the same date next month; 0 months = that day only
  private cardDates(today: DateTime, months: number) {
    return { validFrom: today.toISODate()!, validUntil: today.plus({ months }).toISODate()! };
  }
}
