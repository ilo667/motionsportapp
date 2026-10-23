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
  // Trainer-only note ("ходить через раз", "це Катюха"); never returned by member-facing APIs
  trainerNote: text('trainer_note'),
  // The member's trainer; null = not assigned yet (every trainer sees them under «Без тренера»)
  trainerId: uuid('trainer_id').references((): AnyPgColumn => admins.id),
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
    // Whose training it is: the trainer sees only own slots in calendar, today page and history
    trainerId: uuid('trainer_id')
      .notNull()
      .references((): AnyPgColumn => admins.id),
  },
  // Many halls: trainers work in parallel, so one training per time per trainer
  (table) => [
    uniqueIndex('training_slots_day_time_trainer_idx').on(table.trainingDayId, table.slotTime, table.trainerId),
  ],
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

// Trainer's devices: push when a member cancels or moves a booking. Separate from members' subscriptions
export const adminPushSubscriptions = pgTable('admin_push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id')
    .notNull()
    .references(() => admins.id),
  // Constraint name as it already exists in the DB (created by a one-off SQL script)
  endpoint: text('endpoint').notNull().unique('admin_push_subscriptions_endpoint_key'),
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
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id),
  // Constraint name as it already exists in the DB (created by a one-off SQL script)
  orderId: text('order_id').notNull().unique('payments_order_id_key'),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull().default('UAH'),
  status: text('status').notNull().default('PENDING'), // PENDING | PAID | FAILED | EXPIRED
  liqpayPaymentId: text('liqpay_payment_id'),
  rawCallback: jsonb('raw_callback'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Gym price list, one row per option ("Повний день · 3 місяці"). Shared by all trainers; a trainer changes
// amounts only, rows come from `npm run seed:prices`. Shown in the admin only: payments don't read it yet
// (LiqPay still charges PRICE_UAH in payment.service.ts)
export const priceItems = pgTable('price_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Stable key of the option (seed upserts by it; later payments will reference it)
  code: text('code').notNull().unique(),
  section: text('section').notNull(), // club_card | assigned | group
  title: text('title').notNull(),
  optionLabel: text('option_label'), // "3 місяці", "6 тренувань"; null for a single-option item
  amountUah: integer('amount_uah').notNull(),
  sortOrder: integer('sort_order').notNull(),
  // Who changed the amount last; null = still the seeded value
  updatedBy: uuid('updated_by').references(() => admins.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Every price change, append-only: who, when, from what to what
export const priceChanges = pgTable('price_changes', {
  id: uuid('id').primaryKey().defaultRandom(),
  priceItemId: uuid('price_item_id')
    .notNull()
    .references(() => priceItems.id),
  oldAmountUah: integer('old_amount_uah').notNull(),
  newAmountUah: integer('new_amount_uah').notNull(),
  changedBy: uuid('changed_by')
    .notNull()
    .references(() => admins.id),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});
