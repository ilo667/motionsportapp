import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { eq, and } from 'drizzle-orm';
import { DateTime } from 'luxon';
import {
  admins,
  members,
  trainingDays,
  trainingSlots,
  bookings,
  demoState,
  announcementExamples,
} from '../src/database/schema';
import { DEMO_MEMBER_IDS, DEMO_SCENARIOS } from '../src/demo/demo.service';
import { getDefaultCoachId } from '../src/schedule/default-coach';

const BCRYPT_ROUNDS = 12;
const KY_ZONE = 'Europe/Kyiv';

const DEMO_ADMIN = { username: 'demo', password: 'Demo1234!' };
const DEMO_VIEWER = { code: 'GYM-DEMO', pin: '123456', displayName: 'Demo Viewer' };

const DEMO_BG_MEMBERS = DEMO_MEMBER_IDS.map((id, i) => ({
  id,
  memberCode: `GYM-DEMO${String(i + 1).padStart(4, '0')}`,
  displayName: `Demo Member ${i + 1}`,
}));

const ANNOUNCEMENT_EXAMPLES = [
  'Сьогодні акцент на техніці — прийдіть на 10 хвилин раніше для розминки.',
  'Нагадуємо: форма обовʼязкова, взуття — чисте зальне.',
  'Завтра відкриється запис на наступний тиждень о 14:00.',
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle({ client: pool });

  console.log('Seeding demo admin...');
  const adminHash = await bcrypt.hash(DEMO_ADMIN.password, BCRYPT_ROUNDS);
  const [existingAdmin] = await db
    .select()
    .from(admins)
    .where(eq(admins.username, DEMO_ADMIN.username))
    .limit(1);
  if (existingAdmin) {
    await db.update(admins).set({ passwordHash: adminHash }).where(eq(admins.id, existingAdmin.id));
    console.log('  Updated demo admin password');
  } else {
    await db.insert(admins).values({ username: DEMO_ADMIN.username, passwordHash: adminHash });
    console.log('  Created demo admin');
  }

  // Slots belong to the first coach account, like the app's default schedule
  const coachId = (await getDefaultCoachId(db as never))!;

  console.log('Seeding background demo members...');
  const recoveryPlaceholder = await bcrypt.hash('demo-recovery', BCRYPT_ROUNDS);
  for (const m of DEMO_BG_MEMBERS) {
    const pinHash = await bcrypt.hash('000000', BCRYPT_ROUNDS);
    const [existing] = await db
      .select()
      .from(members)
      .where(eq(members.id, m.id))
      .limit(1);
    if (!existing) {
      await db.insert(members).values({
        id: m.id,
        memberCode: m.memberCode,
        displayName: m.displayName,
        pinHash,
        recoveryHash: recoveryPlaceholder,
      });
      console.log(`  Created ${m.memberCode}`);
    } else {
      console.log(`  Skipped ${m.memberCode} (exists)`);
    }
  }

  console.log('Seeding demo viewer member...');
  const viewerPinHash = await bcrypt.hash(DEMO_VIEWER.pin, BCRYPT_ROUNDS);
  const [existingViewer] = await db
    .select()
    .from(members)
    .where(eq(members.memberCode, DEMO_VIEWER.code))
    .limit(1);
  if (existingViewer) {
    await db
      .update(members)
      .set({ pinHash: viewerPinHash, displayName: DEMO_VIEWER.displayName })
      .where(eq(members.id, existingViewer.id));
    console.log('  Updated viewer member');
  } else {
    await db.insert(members).values({
      memberCode: DEMO_VIEWER.code,
      displayName: DEMO_VIEWER.displayName,
      pinHash: viewerPinHash,
      recoveryHash: recoveryPlaceholder,
    });
    console.log('  Created viewer member');
  }

  console.log('Seeding announcement examples...');
  for (const text of ANNOUNCEMENT_EXAMPLES) {
    await db.insert(announcementExamples).values({ text }).onConflictDoNothing();
  }
  console.log('  Done');

  console.log('Ensuring demo_state row...');
  const [stateRow] = await db.select().from(demoState).limit(1);
  if (!stateRow) {
    await db.insert(demoState).values({ id: 1 });
    console.log('  Created demo_state row');
  } else {
    console.log('  Row exists');
  }

  console.log('Ensuring training days for next 7 days...');
  const now = DateTime.now().setZone(KY_ZONE);
  for (let i = 0; i < 7; i++) {
    const date = now.plus({ days: i }).toISODate()!;
    await db
      .insert(trainingDays)
      .values({ localDate: date, status: 'SCHEDULED', isException: false, updatedAt: new Date() })
      .onConflictDoNothing();

    const [day] = await db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.localDate, date))
      .limit(1);

    if (day) {
      await db
        .insert(trainingSlots)
        .values([
          { trainingDayId: day.id, slotTime: '19:00', status: 'ACTIVE', capacity: 8, bookedCount: 0, coachId },
          { trainingDayId: day.id, slotTime: '20:00', status: 'ACTIVE', capacity: 8, bookedCount: 0, coachId },
        ])
        .onConflictDoNothing();
    }
  }
  console.log('  Done');

  console.log('Applying booking_open scenario...');
  const scenario = DEMO_SCENARIOS.booking_open;
  const today = now.toISODate()!;
  const clockAt = now.set({ hour: scenario.hour, minute: 0, second: 0, millisecond: 0 });

  await db
    .update(demoState)
    .set({ clockOverrideAt: clockAt.toJSDate(), scenarioName: 'booking_open' })
    .where(eq(demoState.id, 1));

  const [day] = await db
    .select()
    .from(trainingDays)
    .where(eq(trainingDays.localDate, today))
    .limit(1);

  if (day) {
    const slots = await db
      .select()
      .from(trainingSlots)
      .where(and(eq(trainingSlots.trainingDayId, day.id), eq(trainingSlots.status, 'ACTIVE')))
      .orderBy(trainingSlots.slotTime);

    if (slots.length >= 2) {
      const [slot1, slot2] = slots;

      await db.delete(bookings).where(eq(bookings.trainingDayId, day.id));
      await db
        .update(trainingSlots)
        .set({ bookedCount: 0 })
        .where(eq(trainingSlots.trainingDayId, day.id));

      const slot1Members = DEMO_MEMBER_IDS.slice(0, scenario.slot1Count);
      const slot2Members = DEMO_MEMBER_IDS.slice(scenario.slot1Count, scenario.slot1Count + scenario.slot2Count);

      if (slot1Members.length > 0) {
        await db.insert(bookings).values(
          slot1Members.map((memberId) => ({
            memberId,
            trainingDayId: day.id,
            slotId: slot1.id,
            status: 'ACTIVE' as const,
          })),
        );
        await db
          .update(trainingSlots)
          .set({ bookedCount: slot1Members.length })
          .where(eq(trainingSlots.id, slot1.id));
      }

      if (slot2Members.length > 0) {
        await db.insert(bookings).values(
          slot2Members.map((memberId) => ({
            memberId,
            trainingDayId: day.id,
            slotId: slot2.id,
            status: 'ACTIVE' as const,
          })),
        );
        await db
          .update(trainingSlots)
          .set({ bookedCount: slot2Members.length })
          .where(eq(trainingSlots.id, slot2.id));
      }

      console.log(`  Slot 19:00 → ${slot1Members.length}/8, Slot 20:00 → ${slot2Members.length}/8`);
    }
  }

  console.log('\nDemo seed complete.');
  console.log('  Admin: demo / Demo1234!');
  console.log('  Viewer: GYM-DEMO / 123456');
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});