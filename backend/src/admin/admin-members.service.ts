import { Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, lte, asc, desc, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { trainingDays, trainingSlots, bookings, members, attendance } from '../database/schema';
import type { UpdateMemberNoteDto } from './dto/update-member-note.dto';
import { ClockService } from '../clock/clock.service';
import { EntitlementsService } from '../purchases/entitlements.service';
import { enabledTrainer, visibleTo } from '../schedule/default-trainer';
import { loadFreezes } from '../freezes/freeze.store';
import { frozenOn, plusDays } from '../freezes/rules';
import { markOf, memberCancellations, toCancellationView } from './admin-views';

// Member-initiated cancellations / moves shown to the trainer (with the reason they wrote)
const CANCELLATION_STATS_DAYS = 30;
const MEMBER_HISTORY_LIMIT = 20;

// «Клієнти» and the client page: the trainer's own and unassigned clients, their trainer, note, visits, cancellations
@Injectable()
export class AdminMembersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // Trainer's client list. trainerNote is admin-only — keep it out of member-facing queries
  async getMembers(adminId: string, onlyId?: string) {
    const since = this.clock.now().minus({ days: CANCELLATION_STATS_DAYS }).toJSDate();
    // Cancellations only (a move to another slot isn't a missed training)
    // Raw, fully qualified SQL: in a single-table select drizzle drops table names, and an unqualified
    // "id" inside the subquery would bind to bookings.id
    const cancelledCount = sql<number>`(
      SELECT count(*)::int FROM bookings b
      WHERE b.member_id = "members"."id"
        AND b.status = 'CANCELLED'
        AND b.cancellation_reason IS NOT NULL
        AND b.switched_to_slot_id IS NULL
        AND b.cancelled_at >= ${since}
    )`;
    const rows = await this.database.db
      .select({
        id: members.id,
        memberCode: members.memberCode,
        displayName: members.displayName,
        trainerNote: members.trainerNote,
        trainerId: members.trainerId,
        createdAt: members.createdAt,
        recentCancellations: cancelledCount,
      })
      .from(members)
      .where(onlyId ? and(visibleTo(adminId), eq(members.id, onlyId)) : visibleTo(adminId))
      .orderBy(asc(members.displayName));

    // «карта до DD.MM», «Перс. 5 · Спліт 2» under each client
    const summaries = await this.entitlements.summaries(rows.map((r) => r.id));
    // «❄ до DD.MM» (last frozen day) under a frozen client
    const today = this.clock.now().toISODate()!;
    const freezes = await loadFreezes(
      this.database.db,
      rows.map((r) => r.id),
    );
    return rows.map((r) => {
      const f = freezes.find((x) => x.memberId === r.id && frozenOn(x, today));
      return {
        ...r,
        clubCard: null,
        packagesLeft: [],
        ...summaries.get(r.id),
        frozenUntil: f ? plusDays(f.endsOn!, -1) : null,
      };
    });
  }

  // Client page: the same row as in the list
  async getMember(adminId: string, memberId: string) {
    const [member] = await this.getMembers(adminId, memberId);
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  // Client page: trainings the member was booked on up to today, with the trainer's mark (newest first)
  async getMemberVisits(adminId: string, memberId: string) {
    await this.ownMember(adminId, memberId);

    const rows = await this.database.db
      .select({
        bookingId: bookings.id,
        localDate: trainingDays.localDate,
        slotTime: trainingSlots.slotTime,
        trainingType: trainingSlots.trainingType,
        status: attendance.status,
      })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
      .where(
        and(
          eq(bookings.memberId, memberId),
          eq(bookings.status, 'ACTIVE'),
          eq(trainingSlots.status, 'ACTIVE'),
          lte(trainingDays.localDate, this.clock.now().toISODate()!),
        ),
      )
      .orderBy(desc(trainingDays.localDate), desc(trainingSlots.slotTime))
      .limit(MEMBER_HISTORY_LIMIT);
    return rows.map(({ status, ...r }) => ({
      ...r,
      attendance: markOf(status),
    }));
  }

  // The trainer's own or unassigned client; anyone else answers 404 like a missing one
  private async ownMember(adminId: string, memberId: string) {
    const [member] = await this.database.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, memberId), visibleTo(adminId)))
      .limit(1);
    if (!member) throw new NotFoundException('Member not found');
  }

  // Clients page: one member's latest cancellations and moves
  async getMemberCancellations(adminId: string, memberId: string) {
    await this.ownMember(adminId, memberId);

    const rows = await memberCancellations(this.database.db, eq(bookings.memberId, memberId), MEMBER_HISTORY_LIMIT);
    return rows.map((r) => ({ ...toCancellationView(r), localDate: r.localDate, slotTime: r.slotTime }));
  }

  async updateMemberNote(adminId: string, memberId: string, dto: UpdateMemberNoteDto) {
    const note = dto.note.trim();
    const [updated] = await this.database.db
      .update(members)
      .set({ trainerNote: note || null })
      .where(and(eq(members.id, memberId), visibleTo(adminId)))
      .returning({ id: members.id, trainerNote: members.trainerNote });

    if (!updated) throw new NotFoundException('Member not found');
    return updated;
  }

  // Hand a client to a trainer (or claim an unassigned one). Only the current trainer can do it; a disabled
  // trainer answers 404 like a missing one
  async assignTrainer(adminId: string, memberId: string, trainerId: string) {
    if (!(await enabledTrainer(this.database.db, trainerId))) throw new NotFoundException('Trainer not found');

    // Checked again in the update itself: the trainer may be disabled in between
    const [updated] = await this.database.db
      .update(members)
      .set({ trainerId })
      .where(
        and(
          eq(members.id, memberId),
          visibleTo(adminId),
          sql`exists (select 1 from admins a where a.id = ${trainerId} and a.disabled_at is null)`,
        ),
      )
      .returning({ id: members.id, trainerId: members.trainerId });
    if (!updated) throw new NotFoundException('Member not found');
    return updated;
  }
}
