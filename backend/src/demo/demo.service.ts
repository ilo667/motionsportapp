import { Injectable, ForbiddenException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { eq, and } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { demoState, trainingDays, trainingSlots, bookings, members, attendance, payments, slotMembers } from '../database/schema';
import { GROUP_TYPE, PERSONAL_MEMBER_LIMITS } from '../schedule/training-types';

const KY_ZONE = 'Europe/Kyiv';

export const DEMO_SCENARIOS = {
  before_14:    { label: 'До 14:00',         hour: 10, slot1Count: 0, slot2Count: 0, slot1Type: 'групові', slot2Type: 'групові' },
  booking_open: { label: 'Запис відкрито',   hour: 15, slot1Count: 7, slot2Count: 3, slot1Type: 'групові', slot2Type: 'групові' },
  one_full:     { label: 'Один слот повний', hour: 15, slot1Count: 8, slot2Count: 3, slot1Type: 'групові', slot2Type: 'групові' },
  after_21:     { label: 'Після 21:00',      hour: 22, slot1Count: 7, slot2Count: 3, slot1Type: 'групові', slot2Type: 'групові' },
  payment_test: { label: 'Тест оплати',      hour: 15, slot1Count: 3, slot2Count: 0, slot1Type: 'групові', slot2Type: 'персональні' },
} as const;

export type ScenarioName = keyof typeof DEMO_SCENARIOS;

// Fixed UUIDs for demo background members (deterministic seed)
export const DEMO_MEMBER_IDS = [
  'a1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000002',
  'a1000000-0000-0000-0000-000000000003',
  'a1000000-0000-0000-0000-000000000004',
  'a1000000-0000-0000-0000-000000000005',
  'a1000000-0000-0000-0000-000000000006',
  'a1000000-0000-0000-0000-000000000007',
  'a1000000-0000-0000-0000-000000000008',
  'a1000000-0000-0000-0000-000000000009',
  'a1000000-0000-0000-0000-000000000010',
];

@Injectable()
export class DemoService {
  constructor(private readonly database: DatabaseService) {}

  requireDemoMode() {
    if (process.env.DEMO_MODE !== 'true') throw new ForbiddenException('Demo mode is not enabled');
  }

  async getNow(): Promise<DateTime> {
    if (process.env.DEMO_MODE !== 'true') return DateTime.now().setZone(KY_ZONE);
    const [row] = await this.database.db.select().from(demoState).limit(1);
    if (row?.clockOverrideAt) return DateTime.fromJSDate(row.clockOverrideAt).setZone(KY_ZONE);
    return DateTime.now().setZone(KY_ZONE);
  }

  isDemoMode(): boolean {
    return process.env.DEMO_MODE === 'true';
  }

  async getInfo() {
    this.requireDemoMode();
    const [row] = await this.database.db.select().from(demoState).limit(1);
    return {
      isDemoMode: true,
      scenarioName: row?.scenarioName ?? null,
      clockOverrideAt: row?.clockOverrideAt?.toISOString() ?? null,
      scenarios: Object.entries(DEMO_SCENARIOS).map(([key, val]) => ({
        name: key,
        label: val.label,
      })),
    };
  }

  async setScenario(scenarioName: ScenarioName) {
    this.requireDemoMode();
    const scenario = DEMO_SCENARIOS[scenarioName];

    const now = DateTime.now().setZone(KY_ZONE);
    const clockAt = now.set({ hour: scenario.hour, minute: 0, second: 0, millisecond: 0 });

    await this.database.db
      .update(demoState)
      .set({ clockOverrideAt: clockAt.toJSDate(), scenarioName })
      .where(eq(demoState.id, 1));

    await this.resetBookingsForScenario(clockAt, scenario.slot1Count, scenario.slot2Count, scenario.slot1Type, scenario.slot2Type);

    return { ok: true, scenarioName, clockAt: clockAt.toISO() };
  }

  async reset() {
    this.requireDemoMode();
    await this.setScenario('booking_open');
    return { ok: true };
  }

  private async resetBookingsForScenario(
    clockAt: DateTime,
    slot1Count: number,
    slot2Count: number,
    slot1Type = 'групові',
    slot2Type = 'групові',
  ) {
    const today = clockAt.toISODate()!;

    // Ensure training day exists for today
    await this.database.db
      .insert(trainingDays)
      .values({ localDate: today, status: 'SCHEDULED', isException: true, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: trainingDays.localDate,
        set: { status: 'SCHEDULED', updatedAt: new Date() },
      });

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.localDate, today))
      .limit(1);

    if (!day) return;

    // Ensure slots exist for today
    for (const [slotTime, trainingType] of [['19:00', slot1Type], ['20:00', slot2Type]]) {
      await this.database.db
        .insert(trainingSlots)
        .values({ trainingDayId: day.id, slotTime, status: 'ACTIVE', trainingType, capacity: 8, bookedCount: 0 })
        .onConflictDoUpdate({
          target: [trainingSlots.trainingDayId, trainingSlots.slotTime],
          set: { status: 'ACTIVE', trainingType, capacity: trainingType === GROUP_TYPE ? 8 : PERSONAL_MEMBER_LIMITS[trainingType].max, bookedCount: 0 },
        });
    }

    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(and(eq(trainingSlots.trainingDayId, day.id), eq(trainingSlots.status, 'ACTIVE')))
      .orderBy(trainingSlots.slotTime);

    // The coach may have added personal trainings that day, so pick the 19:00 / 20:00 slots by time
    const slot1 = slots.find((s) => s.slotTime === '19:00');
    const slot2 = slots.find((s) => s.slotTime === '20:00');
    if (!slot1 || !slot2) return;

    // Delete attendance first (FK constraint), then bookings
    const dayBookings = await this.database.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.trainingDayId, day.id));

    for (const b of dayBookings) {
      await this.database.db.delete(payments).where(eq(payments.bookingId, b.id));
      await this.database.db.delete(attendance).where(eq(attendance.bookingId, b.id));
    }

    await this.database.db
      .delete(bookings)
      .where(eq(bookings.trainingDayId, day.id));

    // Reset counts
    await this.database.db
      .update(trainingSlots)
      .set({ bookedCount: 0 })
      .where(eq(trainingSlots.trainingDayId, day.id));

    // Verify demo members exist
    const demoMembers = await this.database.db
      .select({ id: members.id })
      .from(members)
      .where(
        eq(members.memberCode, 'GYM-DEMO0001'),
      )
      .limit(1);

    // Only seed bookings if demo members are seeded
    const existingMembers = await this.database.db
      .select({ id: members.id })
      .from(members);

    // A personal 20:00 (payment test) is assigned to every real member, so whoever tests sees it
    for (const slot of [slot1, slot2]) {
      await this.database.db.delete(slotMembers).where(eq(slotMembers.slotId, slot.id));
      if (slot.trainingType === GROUP_TYPE) continue;
      const realMembers = existingMembers.filter((m) => !DEMO_MEMBER_IDS.includes(m.id));
      if (realMembers.length > 0) {
        await this.database.db.insert(slotMembers).values(realMembers.map((m) => ({ slotId: slot.id, memberId: m.id })));
      }
    }

    const demoMemberIds = existingMembers
      .map((m) => m.id)
      .filter((id) => DEMO_MEMBER_IDS.includes(id));

    if (demoMemberIds.length === 0) return;

    // Insert bookings for slot1
    const slot1Members = demoMemberIds.slice(0, slot1Count);
    const slot2Members = demoMemberIds.slice(slot1Count, slot1Count + slot2Count);

    if (slot1Members.length > 0) {
      await this.database.db.insert(bookings).values(
        slot1Members.map((memberId) => ({
          memberId,
          trainingDayId: day.id,
          slotId: slot1.id,
          status: 'ACTIVE' as const,
        })),
      );
      await this.database.db
        .update(trainingSlots)
        .set({ bookedCount: slot1Members.length })
        .where(eq(trainingSlots.id, slot1.id));
    }

    if (slot2Members.length > 0) {
      await this.database.db.insert(bookings).values(
        slot2Members.map((memberId) => ({
          memberId,
          trainingDayId: day.id,
          slotId: slot2.id,
          status: 'ACTIVE' as const,
        })),
      );
      await this.database.db
        .update(trainingSlots)
        .set({ bookedCount: slot2Members.length })
        .where(eq(trainingSlots.id, slot2.id));
    }

    void demoMembers; // suppress unused warning
  }
}