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
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { GROUP_TYPE, ASSIGNED_TYPES, PASS_TYPES } from '../schedule/training-types';
import { PRICE_SECTIONS } from '../prices/price-list';

// CHECK that a text column holds one of the known values (NULL passes, so nullable columns stay optional).
// A typo in code then fails loudly instead of quietly writing 'ACTVE'
function oneOf(name: string, column: string, values: readonly string[]) {
  return check(name, sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(', ')})`));
}

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
  // Who sent the invite link; null = added by `npm run seed:admin`
  invitedByAdminId: uuid('invited_by_admin_id').references((): AnyPgColumn => admins.id),
  // Disabled on «Тренери» (can't sign in, clients moved to another trainer); null = works
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  disabledByAdminId: uuid('disabled_by_admin_id').references((): AnyPgColumn => admins.id),
});

// One-time link that lets a new trainer sign up («Запросити тренера»). Only the SHA-256 of the token is stored,
// so the link is shown once, when it is created
export const trainerInvites = pgTable('trainer_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  createdByAdminId: uuid('created_by_admin_id')
    .notNull()
    .references((): AnyPgColumn => admins.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedByAdminId: uuid('used_by_admin_id').references((): AnyPgColumn => admins.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    principalType: text('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [oneOf('sessions_principal_type_check', 'principal_type', ['member', 'admin'])],
);

export const trainingDays = pgTable(
  'training_days',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    localDate: date('local_date').notNull().unique(),
    status: text('status').notNull().default('SCHEDULED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [oneOf('training_days_status_check', 'status', ['SCHEDULED', 'CANCELLED'])],
);

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
    oneOf('training_slots_status_check', 'status', ['ACTIVE', 'CANCELLED']),
    oneOf('training_slots_training_type_check', 'training_type', [GROUP_TYPE, ...ASSIGNED_TYPES]),
    // Safety net for the seat counter: never below zero, never more people than seats
    check('training_slots_booked_count_check', sql`booked_count >= 0 AND booked_count <= capacity AND capacity > 0`),
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
    oneOf('bookings_status_check', 'status', ['ACTIVE', 'CANCELLED']),
    oneOf('bookings_payment_status_check', 'payment_status', ['PENDING', 'PAID']),
  ],
);

export const attendance = pgTable(
  'attendance',
  {
    bookingId: uuid('booking_id')
      .primaryKey()
      .references(() => bookings.id),
    status: text('status').notNull(), // no row = not marked yet
    markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
    markedByAdminId: uuid('marked_by_admin_id')
      .notNull()
      .references(() => admins.id),
  },
  () => [oneOf('attendance_status_check', 'status', ['PRESENT', 'ABSENT'])],
);

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

export const notificationEvents = pgTable(
  'notification_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  () => [oneOf('notification_events_status_check', 'status', ['PENDING', 'SENT', 'FAILED'])],
);

export const announcementExamples = pgTable('announcement_examples', {
  id: uuid('id').primaryKey().defaultRandom(),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const announcements = pgTable(
  'announcements',
  {
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
  },
  () => [oneOf('announcements_source_check', 'source', ['ai', 'fallback', 'manual'])],
);

export const aiGenerations = pgTable(
  'ai_generations',
  {
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
  },
  () => [oneOf('ai_generations_status_check', 'status', ['success', 'fallback'])],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Old per-training payments (removed 2026-10-23) point at a booking; everything since pays a purchase
    bookingId: uuid('booking_id').references(() => bookings.id),
    purchaseId: uuid('purchase_id').references((): AnyPgColumn => purchases.id),
    // Constraint name as it already exists in the DB (created by a one-off SQL script)
    orderId: text('order_id').notNull().unique('payments_order_id_key'),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default('UAH'),
    status: text('status').notNull().default('PENDING'), // PENDING | PAID | FAILED | EXPIRED | REPLACED
    liqpayPaymentId: text('liqpay_payment_id'),
    rawCallback: jsonb('raw_callback'),
    // Money that came after its purchase ended (raw_callback says success, status is not PAID) is shown to the
    // trainer until they press «Розібрано» (gave the purchase by hand or the money was refunded)
    handledAt: timestamp('handled_at', { withTimezone: true }),
    handledByAdminId: uuid('handled_by_admin_id').references(() => admins.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    oneOf('payments_status_check', 'status', ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REPLACED']),
    check('payments_owner_check', sql`booking_id IS NOT NULL OR purchase_id IS NOT NULL`),
  ],
);

// Gym price list, one row per option ("Повний день · 3 місяці"). Shared by all trainers; a trainer changes
// amounts only, rows come from `npm run seed:prices`. A purchase copies the amount at the moment it is made
export const priceItems = pgTable(
  'price_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stable key of the option (the seed upserts by it)
    code: text('code').notNull().unique(),
    section: text('section').notNull(), // club_card | assigned | group
    title: text('title').notNull(),
    optionLabel: text('option_label'), // "3 місяці", "6 тренувань"; null for a single-option item
    amountUah: integer('amount_uah').notNull(),
    sortOrder: integer('sort_order').notNull(),
    // What buying it gives: valid for durationMonths from activation (0 = that day only). Trainer service and
    // group pass: a package of trainingCount trainings for slots of trainingType
    durationMonths: integer('duration_months'),
    trainingType: text('training_type'),
    trainingCount: integer('training_count'),
    // Who changed the amount last; null = still the seeded value
    updatedBy: uuid('updated_by').references(() => admins.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    oneOf('price_items_section_check', 'section', PRICE_SECTIONS),
    check('price_items_amount_check', sql`amount_uah > 0`),
    oneOf('price_items_training_type_check', 'training_type', PASS_TYPES),
  ],
);

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

// A member's order: one trainer service, plus a club card when they had no valid one. Paid by LiqPay
// (activated by the callback / status API) or in cash (activated when their trainer confirms)
export const purchases = pgTable(
  'purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    // The member's trainer when the purchase was made: the one who confirms cash
    trainerId: uuid('trainer_id').references(() => admins.id),
    method: text('method').notNull(),
    status: text('status').notNull().default('PENDING'),
    totalUah: integer('total_uah').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // Trainer who confirmed or rejected cash
    decidedBy: uuid('decided_by').references(() => admins.id),
    // Group pass bought from «Записатися»: the slot to book once paid, and the booking it made
    slotId: uuid('slot_id').references(() => trainingSlots.id),
    bookingId: uuid('booking_id').references(() => bookings.id),
  },
  () => [
    oneOf('purchases_method_check', 'method', ['LIQPAY', 'CASH']),
    oneOf('purchases_status_check', 'status', ['PENDING', 'PAID', 'REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED']),
    check('purchases_total_check', sql`total_uah > 0`),
  ],
);

// Lines of a purchase, with the price list values copied at purchase time (later price changes don't apply)
export const purchaseItems = pgTable('purchase_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  purchaseId: uuid('purchase_id')
    .notNull()
    .references(() => purchases.id),
  priceItemId: uuid('price_item_id')
    .notNull()
    .references(() => priceItems.id),
  title: text('title').notNull(),
  optionLabel: text('option_label'),
  amountUah: integer('amount_uah').notNull(),
});

const A_MONTH_FROM_TODAY = sql`(CURRENT_DATE + INTERVAL '1 month')::date`;

// Access to the gym. From a paid purchase, or added by the trainer (bought at the reception).
// Waits for the trainer's «Активувати з сьогодні» (valid_from / valid_until null); burns after activate_by
export const clubCards = pgTable('club_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberId: uuid('member_id')
    .notNull()
    .references(() => members.id),
  purchaseItemId: uuid('purchase_item_id').references(() => purchaseItems.id), // null = added by the trainer
  label: text('label').notNull(),
  validFrom: date('valid_from'),
  validUntil: date('valid_until'),
  durationMonths: integer('duration_months').notNull().default(0),
  // The code always sets it; the default only fills rows that existed before activation
  activateBy: date('activate_by').notNull().default(A_MONTH_FROM_TODAY),
  addedBy: uuid('added_by').references(() => admins.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Trainings bought in a pack: a trainer service or a group pass. Left = total minus its spends; the oldest usable
// pack is spent first. The first mark activates it (activated_on = that training's date, valid for duration_months);
// not activated by activate_by, it burns
export const packages = pgTable(
  'packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    purchaseItemId: uuid('purchase_item_id')
      .notNull()
      .references(() => purchaseItems.id),
    trainingType: text('training_type').notNull(),
    total: integer('total').notNull(),
    durationMonths: integer('duration_months').notNull().default(1),
    // The code always sets both; the defaults only fill rows that existed before activation
    purchasedOn: date('purchased_on').notNull().defaultNow(),
    activateBy: date('activate_by').notNull().default(A_MONTH_FROM_TODAY),
    activatedOn: date('activated_on'),
    validUntil: date('valid_until'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    oneOf('packages_training_type_check', 'training_type', PASS_TYPES),
    check('packages_total_check', sql`total > 0`),
  ],
);

// One training spent from a package: the trainer marked the booking (✓ or ✗). «—» deletes the row,
// which gives the training back to the same package
export const packageSpends = pgTable('package_spends', {
  bookingId: uuid('booking_id')
    .primaryKey()
    .references(() => bookings.id),
  packageId: uuid('package_id')
    .notNull()
    .references(() => packages.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// A trainer's regular group trainings («Мій розклад»). No row: the first trainer gets the old Mon/Wed/Fri
// 19:00 / 20:00 schedule, any other trainer an empty one (`loadTrainerSchedule`)
// 'HH:MM' on the 15-minute grid, as «Розклад групових» and the calendar use it
const QUARTER_HOUR = "'^([01][0-9]|2[0-3]):(00|15|30|45)$'";

export const trainerSchedules = pgTable(
  'trainer_schedules',
  {
    trainerId: uuid('trainer_id')
      .primaryKey()
      .references(() => admins.id),
    // 'HH:MM' on the training day; one time for every day
    bookingOpensAt: text('booking_opens_at').notNull().default('14:00'),
    // Create the group trainings 3 weeks ahead by themselves
    autoCreate: boolean('auto_create').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check('trainer_schedules_booking_opens_at_check', sql.raw(`booking_opens_at ~ ${QUARTER_HOUR}`))],
);

// One row per group training of the week: weekday as in Luxon (1 = Mon … 7 = Sun), 'HH:MM'
export const trainerScheduleTimes = pgTable(
  'trainer_schedule_times',
  {
    trainerId: uuid('trainer_id')
      .notNull()
      .references(() => admins.id),
    weekday: integer('weekday').notNull(),
    slotTime: text('slot_time').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.trainerId, table.weekday, table.slotTime] }),
    check('trainer_schedule_times_weekday_check', sql`weekday between 1 and 7`),
    check('trainer_schedule_times_slot_time_check', sql.raw(`slot_time ~ ${QUARTER_HOUR}`)),
  ],
);

// «Заморозити абонемент»: the member asks, a trainer approves. Everything the member has (card and packages,
// waiting or active) is frozen from started_on until ends_on (exclusive: the first day back). On approval the
// dates are pushed 30 days ahead at once (`freeze_items`), so a freeze nobody ends finishes by itself; an early
// unfreeze moves them back by the days left. Whether it is over is computed from ends_on, not stored
export const freezes = pgTable(
  'freezes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    status: text('status').notNull().default('REQUESTED'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by').references(() => admins.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    startedOn: date('started_on'),
    endsOn: date('ends_on'),
    unfreezeRequestedAt: timestamp('unfreeze_requested_at', { withTimezone: true }),
    unfreezeDecidedBy: uuid('unfreeze_decided_by').references(() => admins.id),
    unfreezeDecidedAt: timestamp('unfreeze_decided_at', { withTimezone: true }),
  },
  () => [
    oneOf('freezes_status_check', 'status', ['REQUESTED', 'ACTIVE', 'REJECTED', 'CANCELLED']),
    check('freezes_dates_check', sql`status <> 'ACTIVE' or (started_on is not null and ends_on >= started_on)`),
  ],
);

// A date a freeze pushed ahead: a card's or package's valid_until (active) or activate_by (waiting).
// An early unfreeze moves exactly these back
export const freezeItems = pgTable(
  'freeze_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    freezeId: uuid('freeze_id')
      .notNull()
      .references(() => freezes.id),
    clubCardId: uuid('club_card_id').references(() => clubCards.id),
    packageId: uuid('package_id').references(() => packages.id),
    field: text('field').notNull(),
  },
  () => [
    oneOf('freeze_items_field_check', 'field', ['valid_until', 'activate_by']),
    check('freeze_items_target_check', sql`(club_card_id is null) <> (package_id is null)`),
  ],
);
