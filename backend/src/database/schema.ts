import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  date,
  jsonb,
  uniqueIndex,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const members = pgTable('members', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberCode: text('member_code').notNull().unique(),
  displayName: text('display_name').notNull(),
  pinHash: text('pin_hash').notNull(),
  recoveryHash: text('recovery_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  // Coach-only note ("ходить через раз", "це Катюха"); never returned by member-facing APIs
  trainerNote: text('trainer_note'),
  // The member's coach; null = not assigned yet (every coach sees them under «Без тренера»)
  coachId: uuid('coach_id').references((): AnyPgColumn => admins.id),
});

export const admins = pgTable('admins', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  principalType: text('principal_type').notNull(),
  principalId: uuid('principal_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const trainingDays = pgTable('training_days', {
  id: uuid('id').primaryKey().defaultRandom(),
  localDate: date('local_date').notNull().unique(),
  status: text('status').notNull().default('SCHEDULED'),
  isException: boolean('is_exception').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const trainingSlots = pgTable(
  'training_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trainingDayId: uuid('training_day_id')
      .notNull()
      .references(() => trainingDays.id),
    slotTime: text('slot_time').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    trainingType: text('training_type').notNull().default('групові'),
    capacity: integer('capacity').notNull().default(8),
    bookedCount: integer('booked_count').notNull().default(0),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    // Whose training it is: the coach sees only own slots in calendar, today page and history
    coachId: uuid('coach_id')
      .notNull()
      .references((): AnyPgColumn => admins.id),
  },
  (table) => [uniqueIndex('training_slots_day_time_idx').on(table.trainingDayId, table.slotTime)],
);

// Who may see and book an assigned slot (персональні: 1 member, спліт: 1–3). Групові have no rows here
export const slotMembers = pgTable(
  'slot_members',
  {
    slotId: uuid('slot_id')
      .notNull()
      .references(() => trainingSlots.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.slotId, table.memberId] })],
);

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    trainingDayId: uuid('training_day_id')
      .notNull()
      .references(() => trainingDays.id),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => trainingSlots.id),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    paymentStatus: text('payment_status'), // null = free | 'PENDING' | 'PAID'
    // Set when the member moved this booking to another slot (19:00 → 20:00); null + reason = plain cancel
    switchedToSlotId: uuid('switched_to_slot_id').references(() => trainingSlots.id),
  },
  (table) => [
    // One active booking per member per slot. "One group booking per day" is checked in BookingService
    // (assigned trainings don't count), under a lock on the member row
    uniqueIndex('bookings_member_slot_active_idx')
      .on(table.memberId, table.slotId)
      .where(sql`${table.status} = 'ACTIVE'`),
  ],
);

export const attendance = pgTable('attendance', {
  bookingId: uuid('booking_id')
    .primaryKey()
    .references(() => bookings.id),
  status: text('status').notNull(),
  markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
  markedByAdminId: uuid('marked_by_admin_id')
    .notNull()
    .references(() => admins.id),
});

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberId: uuid('member_id')
    .notNull()
    .references(() => members.id),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

// Coach's devices: push when a member cancels or moves a booking. Separate from members' subscriptions
export const adminPushSubscriptions = pgTable('admin_push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id')
    .notNull()
    .references(() => admins.id),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

export const vacancyAlerts = pgTable(
  'vacancy_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => trainingSlots.id),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('vacancy_alerts_member_slot_idx').on(table.memberId, table.slotId)],
);

export const notificationEvents = pgTable('notification_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventType: text('event_type').notNull(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
});

export const announcementExamples = pgTable('announcement_examples', {
  id: uuid('id').primaryKey().defaultRandom(),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const announcements = pgTable('announcements', {
  id: uuid('id').primaryKey().defaultRandom(),
  trainingDayId: uuid('training_day_id')
    .notNull()
    .unique()
    .references(() => trainingDays.id),
  topic: text('topic'),
  text: text('text'),
  source: text('source'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiGenerations = pgTable('ai_generations', {
  id: uuid('id').primaryKey().defaultRandom(),
  announcementId: uuid('announcement_id')
    .notNull()
    .references(() => announcements.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  latencyMs: integer('latency_ms'),
  tokenUsage: integer('token_usage'),
  status: text('status').notNull(),
  fallbackReason: text('fallback_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id').notNull().references(() => bookings.id),
  orderId: text('order_id').notNull().unique(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull().default('UAH'),
  status: text('status').notNull().default('PENDING'), // PENDING | PAID | FAILED | EXPIRED
  liqpayPaymentId: text('liqpay_payment_id'),
  rawCallback: jsonb('raw_callback'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});