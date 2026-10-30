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
  index,
  primaryKey,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { GROUP_TYPE, ASSIGNED_TYPES, PASS_TYPES } from '../schedule/training-types';
import { PRICE_SECTIONS } from '../prices/price-list';

// Postgres doesn't index foreign keys: every frequent lookup column gets an index named <table>_<column>_idx

// CHECK for status-like text columns, so a typo fails loudly. NULL passes, so nullable columns stay optional
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
  // Trainer-only; never returned by member-facing APIs
  trainerNote: text('trainer_note'),
  // null = unassigned, visible to every trainer
  trainerId: uuid('trainer_id').references((): AnyPgColumn => admins.id),
});

export const admins = pgTable('admins', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // null = created by `npm run seed:admin`
  invitedByAdminId: uuid('invited_by_admin_id').references((): AnyPgColumn => admins.id),
  // Set = can't sign in, clients moved to another trainer
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  disabledByAdminId: uuid('disabled_by_admin_id').references((): AnyPgColumn => admins.id),
});

// One-time trainer sign-up link. Only the token's SHA-256 is stored, so the link is shown once
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
  (table) => [
    oneOf('sessions_principal_type_check', 'principal_type', ['member', 'admin']),
    // Looked up on every request
    index('sessions_token_hash_idx').on(table.tokenHash),
  ],
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
    trainingType: text('training_type').notNull().default(GROUP_TYPE),
    capacity: integer('capacity').notNull().default(8),
    bookedCount: integer('booked_count').notNull().default(0),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    // Each trainer sees only own slots
    trainerId: uuid('trainer_id')
      .notNull()
      .references((): AnyPgColumn => admins.id),
  },
  // Trainers work in parallel: one ACTIVE slot per time per trainer. A cancelled slot is never reused, so a new
  // training at that time is a new row and doesn't inherit old bookings or fees
  (table) => [
    uniqueIndex('training_slots_day_time_trainer_idx')
      .on(table.trainingDayId, table.slotTime, table.trainerId)
      .where(sql`status = 'ACTIVE'`),
    oneOf('training_slots_status_check', 'status', ['ACTIVE', 'CANCELLED']),
    oneOf('training_slots_training_type_check', 'training_type', [GROUP_TYPE, ...ASSIGNED_TYPES]),
    // Safety net for the seat counter
    check('training_slots_booked_count_check', sql`booked_count >= 0 AND booked_count <= capacity AND capacity > 0`),
    check('training_slots_cancelled_at_check', sql`status = 'CANCELLED' OR cancelled_at IS NULL`),
  ],
);

// Members of an assigned slot (personal: 1, split: 1-3). Group slots have no rows here
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
  (table) => [
    primaryKey({ columns: [table.slotId, table.memberId] }),
    // The primary key starts with slot_id, so member lookups need their own index
    index('slot_members_member_id_idx').on(table.memberId),
  ],
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
    // Set on a move to another slot; null with a reason = plain cancel
    switchedToSlotId: uuid('switched_to_slot_id').references(() => trainingSlots.id),
    // Late-cancellation fee (booking/cancel-fee.ts): FULL = training spent, HALF = spent plus half refund
    // (cancel_refunds). Waivable until the money is returned
    cancelFee: text('cancel_fee'),
    feeWaivedAt: timestamp('fee_waived_at', { withTimezone: true }),
    feeWaivedBy: uuid('fee_waived_by').references((): AnyPgColumn => admins.id),
  },
  (table) => [
    // "One group booking per day" can't be an index (assigned slots don't count): BookingService checks it
    // under the member row lock
    uniqueIndex('bookings_member_slot_active_idx')
      .on(table.memberId, table.slotId)
      .where(sql`${table.status} = 'ACTIVE'`),
    oneOf('bookings_status_check', 'status', ['ACTIVE', 'CANCELLED']),
    oneOf('bookings_cancel_fee_check', 'cancel_fee', ['FULL', 'HALF']),
    index('bookings_slot_id_idx').on(table.slotId),
    index('bookings_member_id_idx').on(table.memberId),
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

// Free guest of a group booking, one per booking. Takes a seat (booked_count) and is cancelled / moved with
// the booking. Marking a guest spends nothing
export const bookingGuests = pgTable(
  'booking_guests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    name: text('name').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    attendance: text('attendance'), // null = not marked
    markedAt: timestamp('marked_at', { withTimezone: true }),
    markedByAdminId: uuid('marked_by_admin_id').references(() => admins.id),
  },
  (table) => [
    uniqueIndex('booking_guests_booking_active_idx')
      .on(table.bookingId)
      .where(sql`${table.status} = 'ACTIVE'`),
    oneOf('booking_guests_status_check', 'status', ['ACTIVE', 'CANCELLED']),
    oneOf('booking_guests_attendance_check', 'attendance', ['PRESENT', 'ABSENT']),
    check('booking_guests_name_check', sql`char_length(name) between 1 and 40`),
  ],
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

// Separate from members' subscriptions, so member-wide pushes never reach a trainer
export const adminPushSubscriptions = pgTable('admin_push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id')
    .notNull()
    .references(() => admins.id),
  // Pinned to the existing DB name, else db:push offers to truncate
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
    purchaseId: uuid('purchase_id')
      .notNull()
      .references((): AnyPgColumn => purchases.id),
    // Pinned to the existing DB name, else db:push offers to truncate
    orderId: text('order_id').notNull().unique('payments_order_id_key'),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default('UAH'),
    status: text('status').notNull().default('PENDING'),
    liqpayPaymentId: text('liqpay_payment_id'),
    rawCallback: jsonb('raw_callback'),
    // LiqPay `reversed` callback (refund), kept apart from raw_callback; not acted on yet
    refundCallback: jsonb('refund_callback'),
    // Stray money (success callback, status not PAID) stays on the trainer's list until handled
    handledAt: timestamp('handled_at', { withTimezone: true }),
    handledByAdminId: uuid('handled_by_admin_id').references(() => admins.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    oneOf('payments_status_check', 'status', ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REPLACED']),
    index('payments_purchase_id_idx').on(table.purchaseId),
    // expireStale() runs on every schedule load
    index('payments_status_created_at_idx').on(table.status, table.createdAt),
  ],
);

// One row per option, shared by all trainers. Rows come from `npm run seed:prices`; trainers change amounts only
export const priceItems = pgTable(
  'price_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The seed upserts by it
    code: text('code').notNull().unique(),
    section: text('section').notNull(),
    title: text('title').notNull(),
    optionLabel: text('option_label'), // null for a single-option item
    amountUah: integer('amount_uah').notNull(),
    sortOrder: integer('sort_order').notNull(),
    // Months from activation (0 = that day only); packages also get trainingCount trainings of trainingType
    durationMonths: integer('duration_months'),
    trainingType: text('training_type'),
    trainingCount: integer('training_count'),
    // null = seeded value
    updatedBy: uuid('updated_by').references(() => admins.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    oneOf('price_items_section_check', 'section', PRICE_SECTIONS),
    check('price_items_amount_check', sql`amount_uah > 0`),
    oneOf('price_items_training_type_check', 'training_type', PASS_TYPES),
  ],
);

// Append-only
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

// A group pass alone, or a club card and / or a trainer service. Paid by LiqPay or in cash (trainer confirms)
export const purchases = pgTable(
  'purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    // The member's trainer at purchase time: confirms cash
    trainerId: uuid('trainer_id').references(() => admins.id),
    method: text('method').notNull(),
    status: text('status').notNull().default('PENDING'),
    totalUah: integer('total_uah').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => admins.id),
    // Group pass bought while booking: the slot to book once paid, and the booking it made
    slotId: uuid('slot_id').references(() => trainingSlots.id),
    bookingId: uuid('booking_id').references(() => bookings.id),
  },
  (table) => [
    index('purchases_member_id_idx').on(table.memberId),
    oneOf('purchases_method_check', 'method', ['LIQPAY', 'CASH']),
    oneOf('purchases_status_check', 'status', ['PENDING', 'PAID', 'REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED']),
    check('purchases_total_check', sql`total_uah > 0`),
  ],
);

// Price list values copied at purchase time, so later price changes don't apply
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

// Waits (valid_from / valid_until null) until the trainer activates it; burns after activate_by
export const clubCards = pgTable(
  'club_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    purchaseItemId: uuid('purchase_item_id').references(() => purchaseItems.id), // null = added by the trainer
    label: text('label').notNull(),
    validFrom: date('valid_from'),
    validUntil: date('valid_until'),
    durationMonths: integer('duration_months').notNull().default(0),
    // Code always sets it; the default only backfilled old rows
    activateBy: date('activate_by').notNull().default(A_MONTH_FROM_TODAY),
    addedBy: uuid('added_by').references(() => admins.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('club_cards_member_id_idx').on(table.memberId)],
);

// A trainer service or group pass. Left = total minus spends. The first attendance mark activates it
// (activated_on = that training's date); not activated by activate_by, it burns
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
    // Code always sets both; the defaults only backfilled old rows
    purchasedOn: date('purchased_on').notNull().defaultNow(),
    activateBy: date('activate_by').notNull().default(A_MONTH_FROM_TODAY),
    activatedOn: date('activated_on'),
    validUntil: date('valid_until'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('packages_member_id_idx').on(table.memberId),
    oneOf('packages_training_type_check', 'training_type', PASS_TYPES),
    check('packages_total_check', sql`total > 0`),
  ],
);

// One training spent by an attendance mark or a late cancellation. Deleting the row (unmark, waive) gives it
// back to the same package
export const packageSpends = pgTable(
  'package_spends',
  {
    bookingId: uuid('booking_id')
      .primaryKey()
      .references(() => bookings.id),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Counted every time a package's trainings left are computed
    index('package_spends_package_id_idx').on(table.packageId),
  ],
);

// 'HH:MM' on the 15-minute grid
const QUARTER_HOUR = "'^([01][0-9]|2[0-3]):(00|15|30|45)$'";

// Weekly group schedule. No row: the first trainer gets LEGACY_DEFAULT, others an empty one (`loadTrainerSchedule`)
export const trainerSchedules = pgTable(
  'trainer_schedules',
  {
    trainerId: uuid('trainer_id')
      .primaryKey()
      .references(() => admins.id),
    // Same time on every training day
    bookingOpensAt: text('booking_opens_at').notNull().default('14:00'),
    // Create group slots 3 weeks ahead
    autoCreate: boolean('auto_create').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check('trainer_schedules_booking_opens_at_check', sql.raw(`booking_opens_at ~ ${QUARTER_HOUR}`))],
);

// weekday as in Luxon: 1 = Mon ... 7 = Sun
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

// Freezes the card and all packages from started_on to ends_on (exclusive: first day back).
// - approval pushes their dates 30 days ahead at once (freeze_items), so no cron is needed to end it
// - an early unfreeze moves them back by the days left
// - "over" is computed from ends_on, not stored
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
  (table) => [
    index('freezes_member_id_idx').on(table.memberId),
    oneOf('freezes_status_check', 'status', ['REQUESTED', 'ACTIVE', 'REJECTED', 'CANCELLED']),
    check('freezes_dates_check', sql`status <> 'ACTIVE' or (started_on is not null and ends_on >= started_on)`),
  ],
);

// A date a freeze pushed: valid_until (active) or activate_by (waiting). An early unfreeze moves exactly these back
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

// Half refund for a cancel_fee HALF. The app never sends money: the trainer refunds by hand and marks it DONE
export const cancelRefunds = pgTable(
  'cancel_refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .unique()
      .references(() => bookings.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id),
    amountUah: integer('amount_uah').notNull(),
    status: text('status').notNull().default('DUE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true }),
    doneBy: uuid('done_by').references(() => admins.id),
  },
  () => [
    oneOf('cancel_refunds_status_check', 'status', ['DUE', 'DONE', 'CANCELLED']),
    check('cancel_refunds_amount_check', sql`amount_uah > 0`),
  ],
);
