# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Motion Gym** — gym class-booking PWA. Full spec at `PROJECT_SPEC.md` (read before implementing anything). The spec uses "GymFlow" as a codename — the product name is **Motion Gym**.

## Structure

Two independent projects, no shared root `package.json`:

```
frontend/   Next.js 16 App Router — Vercel frontend project
backend/    NestJS 11 — Vercel serverless functions project
```

## Commands

### Frontend (`cd frontend`)
```bash
npm run dev        # localhost:3000
npm run build
npm run lint
```

### Backend (`cd backend`)
```bash
npm run start:dev  # localhost:3001, watch mode
npm run build      # rm -rf dist && nest build
npm run test       # Jest, matches *.spec.ts in src/
npm run test:cov
npm run db:push    # apply src/database/schema.ts to the DB (drizzle-kit push)
npm run seed:admin # create a trainer account (ADMIN_USERNAME / ADMIN_PASSWORD)
npm run seed:prices # add missing price list rows (src/prices/price-list.ts); never overwrites amounts
npm run lint       # check only, does not change files
npm run format     # prettier (printWidth 120); the local pre-commit hook rejects unformatted backend files
```

## Architecture

### Request flow

Frontend (`/api/*`) → Next.js rewrite → `BACKEND_URL` (dev: `localhost:3001`, prod: Vercel backend project). Backend on Vercel uses `backend/api/index.ts` as the serverless entrypoint — it lazily bootstraps NestJS and delegates requests.

App setup (helmet, CORS, `ValidationPipe`, cookie parser) lives in **`configureApp()`** (`backend/src/configure-app.ts`), shared by `main.ts` (local) and `api/index.ts` (Vercel). Add any global middleware there, never in just one entrypoint, or Vercel silently runs without it.

### Security headers

- API: `helmet()` defaults (incl. its CSP and HSTS); fine for JSON, since browsers reach the API only through the `/api` rewrite and LiqPay callbacks / Vercel Cron ignore response headers.
- Frontend pages: `headers()` in `frontend/next.config.ts` sets `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`. **No CSP yet** on pages: it would need tuning for the LiqPay form POST (`form-action`), Next.js inline scripts and fonts; test a payment if you add one. HSTS comes from Vercel.

### Auth

Opaque session token (no JWT) in an `httpOnly`, `sameSite: strict` cookie named **`session`** (`secure` in production, 30 days). The DB stores only its SHA-256 in `sessions` (`principal_type` member | admin, `principal_id`, `expires_at`, `revoked_at`); logout revokes it. `SessionGuard` hashes the cookie, finds a live session and sets `req.user` (`SessionUser`: member or admin). Then `AdminGuard` (admin only) or `MemberGuard` (member only, e.g. payment checkout). `ValidationPipe(whitelist: true)` is global.

Auth endpoints:
- `POST /auth/member/register` — displayName + PIN → memberCode + recoveryCode
- `POST /auth/member/login` — memberCode + PIN
- `POST /auth/member/forgot` — memberCode + recoveryCode + newPin → new recoveryCode
- `POST /auth/admin/login` — username + password
- `POST /auth/logout`
- `GET /auth/me`

### Backend modules

- `DatabaseModule` — global Drizzle ORM provider, reads `DATABASE_URL`
- `AuthModule` — member + admin auth, bcrypt PIN/password/recovery hashes, DB sessions, PIN recovery
- `ScheduleModule` — `GET /schedule/next` — next training day with slots
- `BookingModule` — book / cancel / switch slot (group slots; cancel takes `slotId`, since a member can hold several bookings a day)
- `AdminModule` — admin schedule management, slot cancellation, attendance, clients list (`GET /admin/members`, `PATCH /admin/members/:id/note`)
  - group slots: `PUT /admin/training-days/:date/slots/:slotTime` (19:00 / 20:00 only); assigned: `POST /admin/training-days/:date/assigned-slots` `{slotTime, trainingType, memberIds}`, `PUT /admin/slots/:id/members`
  - cancellation reasons: `GET /admin/slots/:id/cancellations`, `GET /admin/members/:id/cancellations`; `GET /admin/schedule` slots carry `cancellations` and participants' `switchedFromTime`; `GET /admin/members` has `recentCancellations` (30 days, moves not counted)
  - trainers: `GET /admin/trainers` (id + username), `PATCH /admin/members/:id/trainer` `{trainerId}`
  - history: `GET /admin/history?before=YYYY-MM-DD` — past training days (before today), newest first, 14 per page, `nextBefore` cursor; slots built by the same `buildSlotViews` as `GET /admin/schedule` (participants + attendance, «з 19:00», cancellations). Each trainer sees only own trainings
  - attendance is **editable at any time** (today page and history) via `PATCH /admin/bookings/:id/attendance`; "Підтвердити всіх" no longer locks the marks
  - `members.trainer_note` is a **trainer-only** note (max 300). Member-facing code must select explicit columns and never return it (SessionGuard and `/auth/me` already do)
- `NotificationsModule` — push subscriptions, vacancy alerts, internal cron. Every push goes through `notification_events` (`enqueueAndProcess`): sent once, right away; `dedupe_key` stops the same event being sent twice (e.g. the booking-open cron runs twice a day). A failed event stays `FAILED` and is logged; there are **no retries**
  - `/internal/cron/*` routes must be **`@Get`** — Vercel Cron invokes with GET (`vercel-cron/1.0`); a POST route answers 404 and the job silently never runs. Protected by `CRON_SECRET` (`Authorization: Bearer …`, sent by Vercel automatically); missing secret in production → 403. Trigger manually: `vercel crons run /internal/cron/<job>`. Hobby plan: once per day, any minute within the scheduled hour
- `AiModule` — AI announcement generation (Gemini). The gym's weekly programme lives in the **system instruction** (`SYSTEM_INSTRUCTION` in `announcement-generator.service.ts`): понеділок: ноги, середа: кругове тренування, пʼятниця: руки. Each request passes the training date (weekday) so the model picks the topic; `announcements.topic`, when set for a day, overrides it. Change the programme there and bump `PROMPT_VERSION` (stored in `ai_generations.prompt_version`)
- `ClockModule` — global `ClockService.now()`: the only source of "now" (Kyiv time) for booking windows, payments, crons and the admin. Inject it instead of calling `DateTime.now()`, so tests can pin the time. (Demo mode with a frozen clock and scenarios was removed on 2026-10-22.)
- `PaymentModule` — LiqPay payment of a **purchase** (see `PurchasesModule`); there is no per-training payment any more:
  - `POST /payments/checkout` `{purchaseId}` — member's own PENDING LiqPay purchase → LiqPay `{data, signature}` for form POST, amount = `purchases.total_uah`; pressing «Оплатити» again issues a new order_id (old payment → `REPLACED`), or returns `{status: 'PAID'}` if LiqPay says the previous attempt succeeded; a previous attempt that failed for good → 409 (start a new purchase)
  - `POST /payments/liqpay/callback` — public server-to-server callback; verifies SHA1 signature; success → payment PAID **and** purchase PAID **and** `EntitlementsService.activate()` in one transaction; failure → payment and purchase FAILED
  - `GET /payments/status?order=` — member's own order; while PENDING asks LiqPay status API directly (used by `/payment/return`)
  - Expiry: lazily on `GET /schedule/next` (`expireStale()`), PENDING older than `PAYMENT_EXPIRY_MINUTES` — reconciles with LiqPay status API first (lost callback → PAID, LiqPay unreachable → skip). Up to 10 per run, checked in parallel, so a slow LiqPay delays the schedule by one timeout at most. This is the fallback: LiqPay's `expired_date` callback normally ends the purchase first
  - old per-training payments (`booking_id` set, `purchase_id` null) are history only: callbacks just save `raw_callback`, expiry skips them
- `PurchasesModule` — club cards, trainer packages and group passes (design: `docs/superpowers/specs/2026-10-23-purchases-design.md`, then `2026-10-23-activation-and-group-passes-design.md`):
  - tables: `purchases` (member, member's trainer, method `LIQPAY` | `CASH`, status `PENDING` → `PAID` | `REJECTED` | `FAILED` | `EXPIRED` | `CANCELLED`, `total_uah`, `decided_by/at`, `slot_id` / `booking_id` for a group pass bought from «Записатись»), `purchase_items` (price list title / option / amount **copied at purchase time**), `club_cards` (`valid_from`–`valid_until`, null while waiting; `duration_months`, `activate_by`; `purchase_item_id` null = added by the trainer), `packages` (`training_type` групові | персональні | спліт = `PASS_TYPES`, `total`, `duration_months`, `purchased_on`, `activate_by`, `activated_on`, `valid_until`), `package_spends` (one row per booking spent from a package)
  - member (`MemberGuard`): `GET /purchases` (catalog `clubCards` / `services` / `groupPasses`, the card (waiting or active), packages with `left` and `state`, the pending purchase, `canPayCash`), `POST /purchases` `{priceItemIds, method, slotId?}` — allowed sets: a group pass alone; a club card; a trainer service; card + service. A service without a card (waiting or active) → `Club card required`. A club card while the member has one (waiting or active) → 409 `Member already has a club card`; «Мої покупки» then shows no «Клубна карта» tile. `slotId` only with a group pass. One PENDING purchase at a time (409); cash only for a member with a trainer; prices come from the DB, never from the client. Cash → push `CASH_REQUESTED` to the member's trainer. `POST /purchases/:id/cancel`
  - trainer (`AdminGuard`): `GET /admin/purchases/pending` (own clients' cash requests), `POST /admin/purchases/:id/confirm` / `reject` (compare-and-set, only the member's trainer, only CASH; another trainer's → 404; already decided → 409), `GET /admin/members/:id/purchases` (cards with `state`), `POST /admin/members/:id/club-card` `{priceItemId, activate?}` (a card bought at the reception, waiting or active from today); 409 if the client already has a club card (waiting or active), and the page hides «+ Додати клубну карту з рецепції» then, `POST /admin/members/:id/club-cards/:cardId/activate` («Активувати з сьогодні», compare-and-set: only a waiting card, else 409). `GET /admin/members` rows carry `clubCard {state, until}` and `packagesLeft` (usable packages only)
  - **nothing starts on payment** (`EntitlementsService.activate`, its own `EntitlementsModule` to avoid a module cycle; date rules in `purchases/validity.ts`): a club card waits for the trainer's «Активувати з сьогодні», then lasts `duration_months` (0 = «Разове відвідування», that day only); a trainer service or group pass becomes a package that **the first attendance mark activates**, from that training's date, for `duration_months` (1 in the price list, all sizes). Not activated within a month of the purchase day (`activate_by`) → it **burns**; after `valid_until` what is left is gone. A burned / expired card counts as no card
  - **spending**: any attendance mark (✓ or ✗, «Підтвердити всіх», the 22:00 cron) on a booking spends one training from a package of that type **usable on the training's date** (`passUsableOn`: from the purchase day to `activate_by`, or to `valid_until` once active): the one bought for this booking first (`purchases.booking_id`), else the **oldest** with trainings left (`syncSpend`, packages locked `FOR UPDATE OF packages`). The first spend sets `activated_on` / `valid_until`; «—» deletes the spend (back to the **same** package) but **keeps the activation**. No package left → the mark stands, nothing is spent, no debt. So a booked no-show loses the training; no booking = nothing spent. **A cancelled training costs nothing**: cancelling a slot (or «Скасувати мої тренування цього дня») deletes its attendance marks and spends (`releaseMarks`, same transaction), so the trainings go back
  - **group passes**: `BookingService.book` needs `groupPassLeft(memberId, date) > 0`, else 409 `Group pass required`; `GET /schedule/next` carries `groupPassLeft`, and «Записатись» with 0 opens `GroupPassModal` («Купити разово», «Купити абонемент», «Оплата готівкою»). Cash: the purchase books the slot in the same transaction (`tryBookGroup`; can't book → error, nothing bought); the trainer confirms in the hall, «Відхилити» keeps the booking (no debt). LiqPay: the purchase remembers `slot_id`; `activate()` books it once paid. Can't (window closed, slot full) → the pass stays, the payment never fails; `GET /payments/status` says `booked`
  - **`tryBookGroup(tx, now, memberId, slotId)`** (`booking/group-booking.ts`) books inside someone else's transaction without throwing: every rule (own trainer, active slot and day, 14:00–21:00, seats, one group booking a day) is checked **before** the insert, because a unique violation would abort the payment's transaction. Keep it in step with `BookingService.book`
- `PricesModule` — the gym's price list, **one for all trainers** (`GET /admin/prices`, `PATCH /admin/prices/:id` `{amountUah, expectedAmountUah}`), page `/admin/prices` («Ціни» in the menu):
  - `price_items`: one row per option (`section` club_card | assigned | group, `title`, `option_label`, `code`); rows come from `npm run seed:prices`, a trainer changes **amounts only** (no adding / removing). `assigned` = «Послуги тренера» (персональні + спліт), same sense as `ASSIGNED_TYPES`
  - every change goes to `price_changes` (who, when, old → new), append-only, shown under the list. The page warns that the price changes for every trainer before saving
  - the update is compare-and-set on `expectedAmountUah`; if another trainer changed it meanwhile → 409 with the current `amountUah` and `updatedBy`
  - purchases copy the amount at the moment they are made (`purchase_items.amount_uah`), so a later change affects only new purchases. `price_items` also says what buying gives (`duration_months`, `training_type`, `training_count`, set by `seed:prices`; `duration_months` counts from activation). Group items are sold as group passes (`training_type` групові). Members see prices only in the purchase flow, not the full list
- `HealthModule` — `GET /health`

### Trainers — rules

- A trainer **is** an `admins` account (e.g. `admin`, `demo`); there is no separate trainer entity. All trainers are equal (no head trainer yet).
- **Everything a trainer sees in the admin is their own**: trainings (`training_slots.trainer_id`, NOT NULL), clients (`members.trainer_id`), today page, calendar, history. Another trainer's slot, booking or client answers **404** like a missing one (`ownSlot()` / `visibleTo()` in `AdminScheduleService`). **A member sees and books only their trainer's group trainings** (`getMemberTrainerId()`: `members.trainer_id`, or the first trainer for members without one and for visitors); booking or switching to another trainer's group slot answers 404. The booking-open push goes only to clients of trainers with group trainings that day.
- **Many halls: trainers work in parallel.** `training_slots` is UNIQUE (day, time, trainer): two trainers can both have Wednesday 19:00; one trainer can't have two trainings at the same time. The calendar shows only the trainer's own trainings.
- The daily announcement is still one per day (`announcements.training_day_id` UNIQUE), shared by all trainers.
- **Default group trainings appear by themselves**: `ScheduleService.ensureDefaultGroupSlots()` (on `GET /schedule/next`, once per day per instance) adds 19:00 and 20:00 to every Mon/Wed/Fri for 3 weeks ahead, owned by the first trainer account (`getDefaultTrainerId()` = oldest `admins` row). They are real rows, so they show in the calendar and the trainer edits or cancels them like any training. It never overwrites: a time already taken (even by a cancelled slot) is left alone and CANCELLED days are skipped.
- With no group training ahead, `GET /schedule/next` returns `localDate: null` and empty `slots`, but still the member's `assignedSlots`.
- «Скасувати мої тренування цього дня» cancels only this trainer's slots; the day becomes CANCELLED only when no active slot is left on it.
- Clients: a trainer sees **own + unassigned** clients («Без тренера», «Забрати собі»), reassigns under the client's name; the trainer note moves with the client. Assigned trainings can only be given to own/unassigned clients (members already on the slot may stay).
- Trainer push (`MEMBER_CANCELLED`) goes to the trainer **whose training** it is.
- Add a trainer: `ADMIN_USERNAME=… ADMIN_PASSWORD=… npm run seed:admin` (in `backend/`).

### Cancellation reasons — rules

- A member always writes a reason when cancelling or moving 19:00 ↔ 20:00 (`bookings.cancellation_reason`). The time shown is `cancelled_at` (server clock); the client sends no time (the old phone-side `cancellation_reason_at` was removed). A **move** also sets `bookings.switched_to_slot_id` on the old booking; reason without it = plain cancel. System cancellations (the trainer removed the member from an assigned slot or cancelled the slot) have no reason and are never shown as the member's.
- The trainer sees reasons in four places: today page (block «Скасували» under each slot, «з 19:00» next to a moved participant), calendar event modal, clients page (count for 30 days, red from 3, expandable history), and a push to the trainer (`MEMBER_CANCELLED`, sent from `BookingService`; a failed push never fails the member's action).
- Trainer push subscriptions live in **`admin_push_subscriptions`**, separate from members' `push_subscriptions`, so member-wide sends (BOOKING_OPEN) never reach the trainer. `POST /push/subscriptions` routes by session type. **One browser = one role**: a push subscription (one per browser) belongs to whoever is signed in there now.
  - Subscribing under one role switches the same endpoint off in the other table (`upsert` / `upsertAdmin`), so a phone signed in as a member never gets trainer pushes.
  - **Logged out = no pushes**: `api.logout()` first calls `DELETE /push/subscriptions` (while the session still says whose it is), then logs out. Only the server row is switched off; the browser keeps its subscription.
  - On load, `/admin` (`PushSubscribeButton`) and `/` (`resyncExistingSubscription`) re-send an existing browser subscription, so signing in again turns pushes back on without a new permission prompt.
- Raw SQL subqueries: write table names explicitly. In a single-table select drizzle drops table names, so `${members.id}` inside a subquery on `bookings` renders as `"id"` and binds to `bookings.id`.

### Training types — rules

Types (DB value = UI word): `групові`, `персональні` (one person, formerly `індивідуальні`), `спліт`. In code, an **assigned slot** (`ASSIGNED_TYPES`, `isAssignedType`, `assignedSlots`, `AssignedSlotCard`) means `персональні` **or** `спліт`: the trainer assigns its members. Never call that umbrella "personal" (that is the `персональні` type). On the member page assigned slots are listed under «Мої тренування».

Constants and helpers live in `backend/src/schedule/training-types.ts`.
- **Групові**: 19:00 and 20:00, capacity 8, **paid by a group pass** («Разове відвідування» = 1, «Абонемент» = 10; no club card needed), visible to everyone, booking window 14:00–21:00 of that day. **One group booking per member per day** (switch between 19:00 and 20:00), checked in `BookingService` under a `SELECT … FOR UPDATE` on the member row.
- **Персональні / спліт** (assigned): any time in 15-minute steps, on any day. The trainer assigns members in `slot_members` (персональні exactly 1, спліт 1–3); `capacity` is fixed: персональні 1, спліт 3. Only assigned members see the slot (`GET /schedule/next` → `assignedSlots`, with `packageLeft`). **Assigning is booking**: the trainer adding a member creates their ACTIVE booking (no per-training payment); the training is paid from a package when attendance is marked. The member may cancel (with a reason) until the start; shown until one hour after the start. No vacancy alerts.
- Assigned bookings **don't count** toward the one-per-day rule: a member can have a group booking plus several assigned ones on the same day. DB index: `bookings_member_slot_active_idx` UNIQUE (member_id, slot_id) WHERE ACTIVE.
- `training_slots` is UNIQUE (day, slot_time, trainer_id): a trainer can't have two trainings at the same time. A **cancelled** slot at that time is reused (`ON CONFLICT … DO UPDATE … WHERE status = 'CANCELLED'`); the group upsert never takes over an active assigned slot.
- Editing members of an assigned slot: a member new to the slot is booked; a removed one's booking is cancelled (no reason = system, never shown as theirs); a removed member whose attendance is already marked → 409. A member who cancelled themselves is not re-booked when the trainer saves the same list.
- "Наступне тренування" on the member page is the next day **with group slots**; days with only assigned trainings are skipped. The booking-open push and the AI announcement cron skip such days too.

### LiqPay — rules (verified on sandbox 2026-10-22)

The LiqPay docs are incomplete. These rules come from prod logs, so do not "fix" the code back to what the docs suggest:

- **Only documented final statuses change state.** `success`/`sandbox` → PAID (purchase activated); `failure`/`error`/`reversed` → FAILED (purchase failed, nothing activated). Every other status, including undocumented ones, keeps the payment PENDING until expiry. Keep it this way.
- **A declined card returns `try_again`, not `failure`.** The status API returns `result=ok status=try_again` with `err_code=limit` (card 4000000000000002) or `err_code=9859` "Insufficient funds" (card 4000000000009995). Human-readable reasons live in `REJECT_REASONS` in `frontend/components/PaymentResult.tsx`. `try_again` is not in the docs. LiqPay sends **no callback** for it, and the status stays `try_again`. The order remains open for a retry on the same LiqPay page.
- **"Скасувати оплату" on LiqPay** → the status API returns `result=error err_code=payment_not_found`, and no callback is sent. Only apply a status-API response when `result === 'ok'`.
- **Decline → retry with a good card on the same page** produces a single `success` callback for the same `order_id`.
- **Verification cards** (`…3063` 3DS, `…3089` OTP, `…3055` CVV): only OTP shows a step in the sandbox; each one ends with a single `success` callback. If the member abandons the SMS step, the status API returns `phone_verify` with `err_code=wait_info` (not `otp_verify`). It is non-final, so the purchase stays PENDING and "Оплатити" resumes it.
- **Wallets** (Pay 24 → `paytype=privat24`, Apple Pay → `apay`) end with the same single `success` callback as cards; the code ignores `paytype`. With `sandbox_` keys a real card in a wallet is **not charged** (checked with a 0 UAH card).
- **Every checkout passes `expired_date` = now + `PAYMENT_EXPIRY_MINUTES`** (UTC `YYYY-MM-DD HH:mm:ss`). LiqPay then closes the order when our expiry ends the purchase. Without it, an abandoned order stays "В обробці" in the LiqPay cabinet and could still be paid after the purchase is gone. Verified: an attempt to pay after the deadline is refused, and LiqPay sends a callback `status=failure err_code=expired` ("Your payment session has timed out"), so the purchase ends right away.
- **Payment transitions are compare-and-set.** `UPDATE payments … WHERE status = 'PENDING' RETURNING id`; if no row comes back, another request already handled the payment, so do nothing. The purchase moves on only with its own `UPDATE purchases … WHERE status = 'PENDING' RETURNING id`; a success whose purchase is no longer PENDING rolls the payment back and goes to manual handling. Activation happens in the same transaction, so a purchase is activated once. `expireStale()` runs on every `GET /schedule/next`, so concurrent runs are normal. Never write "read status, then update by id".
- **Callbacks are sent only for final statuses**, so never rely on them alone: `/payment/return` and `expireStale()` both reconcile through the status API (`liqpayStatus` in `liqpay.helper.ts`).
- **Test mode is defined by the keys alone** (`sandbox_…` prefix). Never send `sandbox: 1`: it forces every card to succeed and breaks the test cards for declines (`4000000000000002`).
- **`LIQPAY_SERVER_URL`** must be `https://<backend>/payments/liqpay/callback` **without `/api`**. With `/api` LiqPay gets a 404 and payments hang in PENDING. **`FRONTEND_URL`** is required, otherwise LiqPay shows no "back to site" button (`result_url` ends up relative).
- **`server_url` is embedded in each order.** After changing the env var, old orders keep retrying the old URL; this is harmless.
- **Testing:** set `PAYMENT_EXPIRY_MINUTES=2` on Vercel for expiry scenarios, then remove it. Vercel Hobby keeps runtime logs only ~30 min (`vercel logs` without `--since`), so check them right after the scenario. The LiqPay cabinet → payment → "Лог виклику API" keeps callback history.
- **Money arrived for a purchase that no longer awaits it** (callback `success` for an EXPIRED/FAILED/REPLACED payment, or for a purchase the member cancelled): status is not changed, the payload is saved to `payments.raw_callback`, and an error "needs manual handling" is logged. Find such cases with `SELECT * FROM payments WHERE status <> 'PAID' AND raw_callback->>'status' IN ('success','sandbox')`, then refund via the LiqPay cabinet by `payment_id`.
- **Prices come from the price list** (`price_items`, «Ціни»): the purchase total is what LiqPay charges. Nothing is hard-coded any more (the old 700 ₴ `PRICE_UAH` was removed on 2026-10-23).
- **Logs:** every payment decision is logged (`Checkout:`, `LiqPay callback:`, `LiqPay status API:`, `Status check:`, `Expire:`). LiqPay payloads are logged as a safe field subset plus `keys=[…]`; never log names, phones or card masks.

### Database

Drizzle ORM over Neon (PostgreSQL). Schema in `backend/src/database/schema.ts` is the source of truth; `npm run db:push` (drizzle-kit) applies it to the DB. One-off migration scripts are deleted once run (all data is test data during development).

**CHECK constraints on every status-like text column** (`oneOf()` in `schema.ts`: statuses, `training_type`, `payment_status`, `principal_type`, `section`, `source`) plus `0 ≤ booked_count ≤ capacity` and `amount_uah > 0`. **Adding a new value in code (e.g. a payment status) means adding it to the schema's `oneOf` list and running `db:push`**, otherwise the DB rejects the write. **`db:push` does not update an existing CHECK whose list changed** (it reports «Changes applied» and leaves the old list): check `pg_get_constraintdef` and re-create the constraint by hand (`DROP CONSTRAINT` + `ADD CONSTRAINT`, same name), as done for `packages_training_type_check` / `price_items_training_type_check` on 2026-10-23. After schema changes that touch the price list, run `npm run seed:prices`. Training types and price sections come from the code constants (`GROUP_TYPE`, `ASSIGNED_TYPES`, `PRICE_SECTIONS`).

Deliberate copies (kept in sync by code, checked consistent on 2026-10-23): a package's trainings left = `total` minus its `package_spends` (computed, not stored); a package's / card's state (waiting, active, expired, burned) is computed from its dates, not stored; `training_slots.booked_count` (seat counter, updated under the slot row lock), `bookings.payment_status` (only on old per-training bookings, before purchases), `price_items.updated_by/updated_at` (latest `price_changes` row).

`db:push` often re-creates the `slot_members` primary key (`DROP CONSTRAINT … ADD CONSTRAINT … PRIMARY KEY("slot_id","member_id")`): a drizzle-kit bug with composite keys on this Postgres. Harmless (same key, same data); pinning the key's name made it happen on every run, so leave it.

`db:push` needs a real terminal for its questions. **Never answer "truncate"** to a question about adding a unique constraint: it means a constraint name in the DB differs from the schema. Look the name up in `pg_constraint` and pin it in the schema (`.unique('payments_order_id_key')`), as done for `payments` and `admin_push_subscriptions`.

### Frontend conventions

- All backend calls go through `frontend/lib/api.ts` (typed fetch wrapper, `credentials: 'include'`)
- Tailwind CSS v4 — design tokens defined inline in `globals.css` under `@theme`. Use named tokens (`text-accent`, `bg-teal`, `text-muted`, etc.), not arbitrary hex values
- **No `gap-*`** — use `space-y-*` (flex-col), `space-x-*` (inline), or `-m-1`/`m-1` trick for flex-wrap. Pre-commit hook enforces this.
- Fonts: Inter (body, `--font-inter`), Rubik 700 (headings, `--font-geologica`). Use `font-geologica` utility class for headings.
- Logo component: `MotionGymLogo`
- Login pages: `/login` and `/admin/login` are thin wrappers around `LoginForm` (`variant="member" | "admin"`). Per-variant fields, texts, API call and redirect live in the `VARIANTS` config in `components/LoginForm.tsx`; change them there, not in the pages
- Layout: `app/layout.tsx` provides the outer flex container (`max-w-xl`, `px-5`). Pages use `PageLayout` component:
  - `variant="centered"` (default) — logo + vertically centered content (auth/landing pages)
  - `variant="top"` — mini `Header` (logo + optional `action`) + content below (schedule/admin pages)
  - `loading` prop — shows `GymLoader` instead of children
- Schedule polling (`app/page.tsx`, `nextPollDelay`): 5 s inside the booking window; outside it no periodic polling — wake at `bookingOpenAt`/`bookingCloseAt` (computed in server time from `serverTime`) or every 5 min as a safety net; paused while the tab is hidden. Every `fetchSchedule()` reschedules the next poll. Admin page polls every 15 s
- Admin calendar (`app/admin/calendar/page.tsx`) uses **FullCalendar v7**, not v6. Don't copy v6 examples:
  - event colors are `color` / `contrastColor` (v6 `backgroundColor`/`borderColor`/`textColor` are silently ignored);
  - there are no stable `fc-*` class names (theme classes are hashed), so style only via `--fc-classic-*` palette variables (override in `.mg-calendar [data-color-scheme]`, dark mode via `colorScheme="dark"`, `palette.css` must stay imported);
  - no calendar-level `buttonText`: view button labels come from the `uk` locale.
  Default view `timeGridWeek` (17:00–22:00, widened to fit earlier/later assigned trainings) with a `dayGridMonth` toggle. Data is fetched per month for **every** month the visible range touches.
  Clicking a day adds one training (групові = both 19:00 and 20:00; персональні / спліт = time + members); click again to add another. Clicking an event: cancel it, or change the members of an assigned one. Group events show `booked/capacity`; assigned events show members instead of a count (`Спліт · Катя ✓, Оля`, ✓ = paid) and the modal lists each member's payment state
- Auth state: `mg_authed` in `localStorage` — set on login, cleared on logout/401. Home page skips API call when flag is absent (avoids 401 in console for unauthenticated users)

## Vercel deployment

Two separate Vercel projects pointing at this repo:
- **frontend project** — root: `frontend/`
- **backend project** — root: `backend/`, entry: `api/index.ts`, rewrites all to `/api`

Required env vars:
- Backend: `DATABASE_URL`, `FRONTEND_URL`, `CRON_SECRET` (random ≥16 chars, required for crons in production)
- Backend (push): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
- Backend (AI announcements): `GEMINI_API_KEY` (without it a fallback text is used)
- Backend (payments): `LIQPAY_PUBLIC_KEY`, `LIQPAY_PRIVATE_KEY`, `LIQPAY_SERVER_URL`, `PAYMENT_EXPIRY_MINUTES` (default `15`; set e.g. `2` to test expiry)
- Frontend: `BACKEND_URL`