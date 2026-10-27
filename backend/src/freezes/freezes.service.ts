import { DateTime } from 'luxon';
import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { ClockService } from '../clock/clock.service';
import {
  admins,
  bookings,
  clubCards,
  freezeItems,
  freezes,
  members,
  packages,
  purchases,
  trainingDays,
  trainingSlots,
  vacancyAlerts,
} from '../database/schema';
import { EntitlementsService, USED } from '../purchases/entitlements.service';
import { cardState, passState } from '../purchases/validity';
import { NotificationService } from '../notifications/notification.service';
import { slotStartsAt } from '../schedule/training-types';
import { openFreeze } from './freeze.store';
import { cancelGuests, freeSeats, lockMember } from '../booking/group-booking';
import { FREEZE_DAYS, daysBetween, plusDays } from './rules';
import { requireVisibleMember, visibleTo } from '../schedule/default-trainer';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Freezes shown on a client's page
const MEMBER_FREEZES_LIMIT = 10;

// An active freeze whose member asked to unfreeze, not over yet
const unfreezeAsked = (today: string) =>
  and(eq(freezes.status, 'ACTIVE'), sql`${freezes.unfreezeRequestedAt} is not null`, sql`${freezes.endsOn} > ${today}`);

type FreezeState = 'requested' | 'active' | 'unfreeze_requested';

// «Заморозити абонемент»: the member asks, a trainer approves; the same for «Розморозити». Everything the member
// has (club card, packages, waiting or active) stops for the frozen days: approving pushes its dates 30 days
// ahead at once, an early unfreeze moves them back by the days left (rules.ts, schema `freezes`)
@Injectable()
export class FreezesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationService,
  ) {}

  private today() {
    return this.clock.now().toISODate()!;
  }

  // The member's open freeze for «Мій абонемент» (null = none), and whether there is anything to freeze
  async forMember(memberId: string) {
    const open = await openFreeze(this.database.db, memberId, this.today());
    return {
      freeze: open
        ? {
            id: open.id,
            state: freezeState(open),
            startedOn: open.startedOn,
            until: open.endsOn ? plusDays(open.endsOn, -1) : null,
          }
        : null,
      canFreeze: !open && (await this.hasSomethingToFreeze(memberId)),
    };
  }

  // A card or a package with trainings left, waiting or active
  private async hasSomethingToFreeze(memberId: string, db: Db | Tx = this.database.db) {
    if (await this.entitlements.usableCard(memberId, db)) return true;
    const packs = await this.entitlements.packagesOf(memberId, db);
    return packs.some((p) => p.state === 'waiting' || p.state === 'active');
  }

  async request(memberId: string) {
    const { freezeId, trainerId, displayName } = await this.database.db.transaction(async (tx) => {
      const member = await this.lockMember(tx, memberId);
      if (await openFreeze(tx, memberId, this.today())) throw new ConflictException('Freeze already requested');
      // A purchase paid during the freeze would start after its dates were pushed: finish it first
      const [pending] = await tx
        .select({ id: purchases.id })
        .from(purchases)
        .where(and(eq(purchases.memberId, memberId), eq(purchases.status, 'PENDING')))
        .limit(1);
      if (pending) throw new ConflictException('Purchase pending');
      if (!(await this.hasSomethingToFreeze(memberId, tx))) throw new ConflictException('Nothing to freeze');
      const [row] = await tx
        .insert(freezes)
        .values({ memberId, status: 'REQUESTED', requestedAt: this.clock.now().toJSDate() })
        .returning({ id: freezes.id });
      return { freezeId: row.id, trainerId: member.trainerId, displayName: member.displayName };
    });
    await this.notifications.enqueueAndProcess('FREEZE_REQUESTED', `freeze-requested:${freezeId}`, {
      trainerId,
      displayName,
      kind: 'freeze',
    });
    return { ok: true };
  }

  // Only while the trainer hasn't decided
  async cancelRequest(memberId: string) {
    const [done] = await this.database.db
      .update(freezes)
      .set({ status: 'CANCELLED' })
      .where(and(eq(freezes.memberId, memberId), eq(freezes.status, 'REQUESTED')))
      .returning({ id: freezes.id });
    if (!done) throw new ConflictException('No freeze request');
    return { ok: true };
  }

  async requestUnfreeze(memberId: string) {
    const today = this.today();
    const now = this.clock.now().toJSDate();
    const [done] = await this.database.db
      .update(freezes)
      .set({ unfreezeRequestedAt: now })
      .where(
        and(
          eq(freezes.memberId, memberId),
          eq(freezes.status, 'ACTIVE'),
          sql`${freezes.endsOn} > ${today}`,
          isNull(freezes.unfreezeRequestedAt),
        ),
      )
      .returning({ id: freezes.id });
    if (!done) throw new ConflictException('Nothing to unfreeze');
    const [member] = await this.database.db
      .select({ trainerId: members.trainerId, displayName: members.displayName })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    await this.notifications.enqueueAndProcess('FREEZE_REQUESTED', `unfreeze-requested:${done.id}:${now.getTime()}`, {
      trainerId: member?.trainerId ?? null,
      displayName: member?.displayName ?? '',
      kind: 'unfreeze',
    });
    return { ok: true };
  }

  // Requests of the trainer's own and unassigned clients, oldest first
  async pending(trainerId: string) {
    const today = this.today();
    const rows = await this.database.db
      .select({
        id: freezes.id,
        memberId: freezes.memberId,
        displayName: members.displayName,
        status: freezes.status,
        requestedAt: freezes.requestedAt,
        startedOn: freezes.startedOn,
        endsOn: freezes.endsOn,
        unfreezeRequestedAt: freezes.unfreezeRequestedAt,
      })
      .from(freezes)
      .innerJoin(members, eq(members.id, freezes.memberId))
      .where(and(visibleTo(trainerId), or(eq(freezes.status, 'REQUESTED'), unfreezeAsked(today))))
      .orderBy(freezes.requestedAt);
    return rows.map((r) => ({
      id: r.id,
      memberId: r.memberId,
      displayName: r.displayName,
      kind: r.status === 'REQUESTED' ? ('freeze' as const) : ('unfreeze' as const),
      requestedAt: (r.status === 'REQUESTED' ? r.requestedAt : r.unfreezeRequestedAt!).toISOString(),
      startedOn: r.startedOn,
      // Last frozen day; a request approved now would freeze until FREEZE_DAYS from today
      until: plusDays(r.status === 'REQUESTED' ? plusDays(today, FREEZE_DAYS) : r.endsOn!, -1),
    }));
  }

  // From today for 30 days. One transaction: the freeze, the pushed dates, and the member's trainings in that time
  // cancelled (system cancellations, no reason). The member row lock makes a booking at that moment wait and then
  // find the member frozen
  async approve(trainerId: string, freezeId: string) {
    const today = this.today();
    const now = this.clock.now();
    const endsOn = plusDays(today, FREEZE_DAYS);
    const { memberId, freed } = await this.database.db.transaction(async (tx) => {
      const freeze = await this.visibleFreeze(tx, trainerId, freezeId);
      await this.lockMember(tx, freeze.memberId);
      const [done] = await tx
        .update(freezes)
        .set({
          status: 'ACTIVE',
          startedOn: today,
          endsOn,
          decidedBy: trainerId,
          decidedAt: now.toJSDate(),
        })
        .where(and(eq(freezes.id, freezeId), eq(freezes.status, 'REQUESTED')))
        .returning({ memberId: freezes.memberId });
      if (!done) throw new ConflictException('Freeze was already decided');

      await this.pushDates(tx, freezeId, done.memberId, today, FREEZE_DAYS);

      const freed = await this.cancelBookingsAhead(tx, done.memberId, today, endsOn, now);
      // No «З'явилось місце» while frozen
      await tx.update(vacancyAlerts).set({ active: false }).where(eq(vacancyAlerts.memberId, done.memberId));
      return { memberId: done.memberId, freed };
    });

    for (const b of freed) {
      await this.notifications.enqueueAndProcess('VACANCY', `vacancy:${b.slotId}:${b.id}`, {
        slotId: b.slotId,
        slotTime: b.slotTime,
        localDate: b.localDate,
        excludeMemberId: memberId,
      });
    }
    await this.notifyDecided(`freeze-decided:${freezeId}`, {
      memberId,
      kind: 'freeze',
      approved: true,
      until: plusDays(endsOn, -1),
    });
    return { ok: true };
  }

  async reject(trainerId: string, freezeId: string) {
    const memberId = await this.database.db.transaction(async (tx) => {
      await this.visibleFreeze(tx, trainerId, freezeId);
      const [done] = await tx
        .update(freezes)
        .set({ status: 'REJECTED', decidedBy: trainerId, decidedAt: this.clock.now().toJSDate() })
        .where(and(eq(freezes.id, freezeId), eq(freezes.status, 'REQUESTED')))
        .returning({ memberId: freezes.memberId });
      if (!done) throw new ConflictException('Freeze was already decided');
      return done.memberId;
    });
    await this.notifyDecided(`freeze-decided:${freezeId}`, { memberId, kind: 'freeze', approved: false });
    return { ok: true };
  }

  // Ends today: the dates pushed ahead go back by the days that were left
  async approveUnfreeze(trainerId: string, freezeId: string) {
    const today = this.today();
    const now = this.clock.now().toJSDate();
    const memberId = await this.database.db.transaction(async (tx) => {
      await this.visibleFreeze(tx, trainerId, freezeId);
      const [freeze] = await tx
        .select({ memberId: freezes.memberId, endsOn: freezes.endsOn })
        .from(freezes)
        .where(and(eq(freezes.id, freezeId), unfreezeAsked(today)))
        .for('update')
        .limit(1);
      if (!freeze) throw new ConflictException('Unfreeze was already decided');
      const back = daysBetween(today, freeze.endsOn!);
      await tx
        .update(freezes)
        .set({ endsOn: today, unfreezeDecidedBy: trainerId, unfreezeDecidedAt: now })
        .where(eq(freezes.id, freezeId));
      await this.moveDates(tx, freezeId, -back);
      return freeze.memberId;
    });
    await this.notifyDecided(`unfreeze-decided:${freezeId}:${now.getTime()}`, {
      memberId,
      kind: 'unfreeze',
      approved: true,
    });
    return { ok: true };
  }

  // The freeze goes on; the member may ask again
  async rejectUnfreeze(trainerId: string, freezeId: string) {
    const now = this.clock.now().toJSDate();
    const memberId = await this.database.db.transaction(async (tx) => {
      await this.visibleFreeze(tx, trainerId, freezeId);
      const [done] = await tx
        .update(freezes)
        .set({ unfreezeRequestedAt: null })
        .where(
          and(eq(freezes.id, freezeId), eq(freezes.status, 'ACTIVE'), sql`${freezes.unfreezeRequestedAt} is not null`),
        )
        .returning({ memberId: freezes.memberId });
      if (!done) throw new ConflictException('Unfreeze was already decided');
      return done.memberId;
    });
    await this.notifyDecided(`unfreeze-decided:${freezeId}:${now.getTime()}`, {
      memberId,
      kind: 'unfreeze',
      approved: false,
    });
    return { ok: true };
  }

  // A client's page: latest freezes with who decided
  async memberHistory(trainerId: string, memberId: string) {
    await requireVisibleMember(this.database.db, trainerId, memberId);
    const today = this.today();
    const rows = await this.database.db
      .select({
        id: freezes.id,
        status: freezes.status,
        requestedAt: freezes.requestedAt,
        startedOn: freezes.startedOn,
        endsOn: freezes.endsOn,
        unfreezeRequestedAt: freezes.unfreezeRequestedAt,
        decidedBy: admins.username,
      })
      .from(freezes)
      .leftJoin(admins, eq(admins.id, freezes.decidedBy))
      .where(eq(freezes.memberId, memberId))
      .orderBy(desc(freezes.requestedAt))
      .limit(MEMBER_FREEZES_LIMIT);
    return rows.map((r) => ({
      id: r.id,
      // ACTIVE splits by date: going on, or over
      status: r.status === 'ACTIVE' ? (today < r.endsOn! ? 'ACTIVE' : 'ENDED') : r.status,
      requestedAt: r.requestedAt.toISOString(),
      startedOn: r.startedOn,
      // Last frozen day (none for a request never approved)
      until: r.endsOn ? plusDays(r.endsOn, -1) : null,
      unfreezeRequested: !!r.unfreezeRequestedAt,
      decidedBy: r.decidedBy,
    }));
  }

  // The member's trainings not started yet, before the freeze ends: cancelled (system cancellations, no reason) with
  // their guests, seats freed. Slots locked as BookingService does. Returns those that were full (for «З'явилось місце»)
  private async cancelBookingsAhead(tx: Tx, memberId: string, today: string, endsOn: string, now: DateTime) {
    const toCancel = await tx
      .select({
        id: bookings.id,
        slotId: bookings.slotId,
        slotTime: trainingSlots.slotTime,
        localDate: trainingDays.localDate,
      })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .where(
        and(
          eq(bookings.memberId, memberId),
          eq(bookings.status, 'ACTIVE'),
          gte(trainingDays.localDate, today),
          lt(trainingDays.localDate, endsOn),
        ),
      )
      .for('update', { of: trainingSlots });
    const ahead = toCancel.filter((b) => slotStartsAt(b.localDate, b.slotTime) > now);
    if (ahead.length === 0) return [];
    const ids = ahead.map((b) => b.id);
    const at = now.toJSDate();
    await tx
      .update(bookings)
      .set({ status: 'CANCELLED', cancelledAt: at })
      .where(and(inArray(bookings.id, ids), eq(bookings.status, 'ACTIVE')));
    // Guests go with the bookings: one more seat each
    const withGuest = await cancelGuests(tx, ids, at);
    const freed: typeof ahead = [];
    for (const b of ahead) {
      if (await freeSeats(tx, b.slotId, withGuest.has(b.id) ? 2 : 1)) freed.push(b);
    }
    return freed;
  }

  // Every card and package the member has on `from` (waiting or active, trainings left) gets its date pushed
  // `days` ahead: valid_until when active, activate_by when waiting. Remembered in freeze_items for an early unfreeze
  private async pushDates(tx: Tx, freezeId: string, memberId: string, from: string, days: number) {
    const cards = await tx
      .select({
        id: clubCards.id,
        activateBy: clubCards.activateBy,
        validFrom: clubCards.validFrom,
        validUntil: clubCards.validUntil,
      })
      .from(clubCards)
      .where(eq(clubCards.memberId, memberId))
      .for('update');
    const packs = await tx
      .select({
        id: packages.id,
        total: packages.total,
        used: USED,
        purchasedOn: packages.purchasedOn,
        activateBy: packages.activateBy,
        activatedOn: packages.activatedOn,
        validUntil: packages.validUntil,
      })
      .from(packages)
      .where(eq(packages.memberId, memberId))
      .for('update');

    const items: (typeof freezeItems.$inferInsert)[] = [];
    for (const c of cards) {
      const state = cardState(c, from);
      if (state === 'active') items.push({ freezeId, clubCardId: c.id, field: 'valid_until' });
      else if (state === 'waiting') items.push({ freezeId, clubCardId: c.id, field: 'activate_by' });
    }
    for (const p of packs) {
      const state = passState({ ...p, left: p.total - p.used }, from);
      if (state === 'active') items.push({ freezeId, packageId: p.id, field: 'valid_until' });
      else if (state === 'waiting') items.push({ freezeId, packageId: p.id, field: 'activate_by' });
    }
    if (items.length === 0) return;
    await tx.insert(freezeItems).values(items);
    await this.moveDates(tx, freezeId, days);
  }

  // Moves every date the freeze pushed by `days` (negative = back)
  private async moveDates(tx: Tx, freezeId: string, days: number) {
    if (days === 0) return;
    const items = await tx
      .select({ clubCardId: freezeItems.clubCardId, packageId: freezeItems.packageId, field: freezeItems.field })
      .from(freezeItems)
      .where(eq(freezeItems.freezeId, freezeId));
    for (const i of items) {
      if (i.clubCardId) {
        await tx
          .update(clubCards)
          .set(
            i.field === 'valid_until'
              ? { validUntil: sql`${clubCards.validUntil} + ${days}::int` }
              : { activateBy: sql`${clubCards.activateBy} + ${days}::int` },
          )
          .where(eq(clubCards.id, i.clubCardId));
      } else if (i.packageId) {
        await tx
          .update(packages)
          .set(
            i.field === 'valid_until'
              ? { validUntil: sql`${packages.validUntil} + ${days}::int` }
              : { activateBy: sql`${packages.activateBy} + ${days}::int` },
          )
          .where(eq(packages.id, i.packageId));
      }
    }
  }

  // «FREEZE_DECIDED» to the member: a freeze or an early unfreeze approved or not (until: the last frozen day)
  private notifyDecided(
    dedupeKey: string,
    payload: { memberId: string; kind: 'freeze' | 'unfreeze'; approved: boolean; until?: string },
  ) {
    return this.notifications.enqueueAndProcess('FREEZE_DECIDED', dedupeKey, payload);
  }

  // Own clients' and unassigned clients' freezes; anyone else's answers 404 like a missing one
  private async visibleFreeze(tx: Tx, trainerId: string, freezeId: string) {
    const [row] = await tx
      .select({ memberId: freezes.memberId })
      .from(freezes)
      .innerJoin(members, eq(members.id, freezes.memberId))
      .where(and(eq(freezes.id, freezeId), visibleTo(trainerId)))
      .limit(1);
    if (!row) throw new NotFoundException('Freeze not found');
    return row;
  }

  // The member lock shared with bookings and purchases (lockMember): a freeze and a booking never interleave
  private async lockMember(tx: Tx, memberId: string) {
    const member = await lockMember(tx, memberId);
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }
}

function freezeState(f: { status: string; unfreezeRequestedAt: Date | null }): FreezeState {
  if (f.status === 'REQUESTED') return 'requested';
  return f.unfreezeRequestedAt ? 'unfreeze_requested' : 'active';
}
