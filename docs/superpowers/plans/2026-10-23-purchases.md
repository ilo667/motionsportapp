# Purchases (club cards + trainer packages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member buys a trainer package (персональне / спліт, 1–12 trainings) and, when they have no valid club card, a club card first; pays by LiqPay or cash confirmed by their trainer. Attendance marks spend trainings from the package.

**Architecture:** New `purchases` module owns purchases, their snapshot lines, club cards, packages and per-booking spends. `PaymentService` keeps its LiqPay state machine (compare-and-set, reconcile, expiry) but now pays a *purchase* instead of a booking; the per-slot 700 ₴ checkout and `PRICE_UAH` are removed. Assigning a member to an assigned slot now creates their booking directly; marking attendance (✓/✗, also the 22:00 cron) spends one training from the oldest matching package, «—» gives it back.

**Tech Stack:** NestJS 11, Drizzle ORM (Neon Postgres, `db:push`), Jest; Next.js 16 App Router, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-10-23-purchases-design.md` (mockup: https://claude.ai/artifact/MSAG1K2rZcqifkJjp3pZWF)

## Global Constraints

- All "now" from `ClockService.now()` (Kyiv); dates for cards are Kyiv `ISODate`.
- Every status transition is compare-and-set: `UPDATE … WHERE status = 'PENDING' RETURNING`; no row back → someone else handled it, do nothing.
- LiqPay rules in CLAUDE.md stay: only `success`/`sandbox` → paid, `failure`/`error`/`reversed` → failed, anything else stays PENDING; apply status-API answers only when `result === 'ok'`; every checkout sends `expired_date`; never send `sandbox: 1`; log only the safe field subset.
- Every new status-like text column gets a `oneOf()` CHECK in `schema.ts`; new values go there.
- Trainer sees only own clients/purchases: another trainer's purchase or member answers **404** (`visibleTo()` rule).
- The server takes prices from `price_items` at purchase time; the client never sends an amount.
- Group trainings stay free; group price items (`section = 'group'`) cannot be bought.
- Frontend: no `gap-*` (pre-commit hook), named color tokens only, all API calls via `lib/api.ts`.
- Backend: `npm run format` (prettier, printWidth 120) before commit; `npm test`, `npm run lint`, `npm run build` green.
- UI copy in Ukrainian, as in the mockup (exact strings in the tasks).

## Review Focus

1. **Callback and status API race on the same order** → the purchase is activated once (one card / one package), never twice. Test in Task 3.
2. **Old LiqPay tab paid after the member cancelled the purchase or started a new checkout** → no activation; payload saved to `raw_callback`, "needs manual handling" logged. Test in Task 3.
3. **Attendance toggled ✓ → ✗ → ✓, or ✓ → «—» → ✓** → at most one spend per booking; «—» returns it to the same package. Tests in Task 2.
4. **Two packages of one type, first one exhausted** → spends go to the oldest package with trainings left, then the next; no package left → mark saved, nothing spent. Tests in Task 2.
5. **Cash by a member without a trainer, or a trainer confirming another trainer's request** → 400 and 404, nothing activated. Tests in Tasks 4 and 5.

---

### Task 1: Schema, price metadata, legacy cleanup

**Files:**
- Modify: `backend/src/database/schema.ts`
- Modify: `backend/src/prices/price-list.ts`, `backend/scripts/seed-prices.ts`
- Test: `backend/src/prices/prices.service.spec.ts` (seed list test)

**Interfaces:**
- Produces tables (drizzle names in parentheses):
  - `price_items` + `training_type text null` (CHECK `oneOf(ASSIGNED_TYPES)`), `training_count integer null`, `duration_months integer null` (0 = «Разове відвідування», valid one day).
  - `purchases` (`purchases`): `id`, `member_id` → members NOT NULL, `trainer_id` → admins NULL (member's trainer when created; confirms cash), `method` text NOT NULL `oneOf ['LIQPAY','CASH']`, `status` text NOT NULL default `'PENDING'` `oneOf ['PENDING','PAID','REJECTED','FAILED','EXPIRED','CANCELLED']`, `total_uah` integer NOT NULL CHECK > 0, `created_at`, `decided_at` timestamptz NULL, `decided_by` → admins NULL.
  - `purchase_items` (`purchaseItems`): `id`, `purchase_id` → purchases NOT NULL, `price_item_id` → price_items NOT NULL, `title`, `option_label` NULL, `amount_uah` (snapshot at purchase time).
  - `club_cards` (`clubCards`): `id`, `member_id` NOT NULL, `purchase_item_id` → purchase_items NULL (NULL = added by trainer), `label` text NOT NULL, `valid_from` date NOT NULL, `valid_until` date NOT NULL, `added_by` → admins NULL, `created_at`.
  - `packages` (`packages`): `id`, `member_id` NOT NULL, `purchase_item_id` NOT NULL, `training_type` `oneOf(ASSIGNED_TYPES)`, `total` integer CHECK > 0, `created_at` (activation time; "oldest first" orders by it).
  - `package_spends` (`packageSpends`): `booking_id` uuid PK → bookings, `package_id` → packages NOT NULL, `created_at`.
  - `payments`: `booking_id` becomes NULLable; add `purchase_id` → purchases NULL; CHECK `payments_owner_check`: `booking_id IS NOT NULL OR purchase_id IS NOT NULL`.
- `PriceListItem` gains `trainingType?: 'персональні' | 'спліт'`, `trainingCount?: number`, `durationMonths?: number`.

- [ ] **Step 1: Extend the seed-list test** in `prices.service.spec.ts`: every `club_card` item has an integer `durationMonths >= 0` and no `trainingType`; every `assigned` item has `trainingType` in `ASSIGNED_TYPES` and `trainingCount` in `[1, 6, 8, 12]`; `club_single` has `durationMonths: 0`; `group` items have neither.
- [ ] **Step 2: Run** `cd backend && npx jest src/prices` → FAIL (fields missing).
- [ ] **Step 3: Add the fields** to `DEFAULT_PRICE_LIST` (months 1 / 3 / 6 from the option label; personal_* → `персональні`, split_* → `спліт`, counts from the label).
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Schema** as in Interfaces. `trainingType` column on `price_items` and `packages` uses `oneOf(..., ASSIGNED_TYPES)`.
- [ ] **Step 6: Seed upserts metadata, never amounts:** `onConflictDoUpdate({ target: priceItems.code, set: { section, title, optionLabel, sortOrder, trainingType, trainingCount, durationMonths } })` using `sql\`excluded.<col>\``; log stays "N added, M updated".
- [ ] **Step 7: Legacy pending payments.** Run read-only: `select count(*) from payments where status = 'PENDING'`. If > 0, **ask the user** before `update payments set status = 'EXPIRED' where status = 'PENDING' and purchase_id is null` (old per-slot payments; test data).
- [ ] **Step 8: Apply:** `npm run db:push` (if it asks anything, stop and show the question to the user; never answer "truncate"), then `npm run seed:prices` → "0 added, 19 updated". Second `db:push` → "No changes detected".
- [ ] **Step 9: Verify & commit:** `npm test && npm run lint && npm run build`; `git commit -m "feat(db): purchases, club cards, packages, spends; price metadata"`.

### Task 2: Entitlements: activation, card, packages, spends

**Files:**
- Create: `backend/src/purchases/entitlements.service.ts`, `backend/src/purchases/entitlements.module.ts` (provides and exports only `EntitlementsService`, so `PaymentModule`, `PurchasesModule`, `AdminScheduleModule`, `ScheduleModule` and `NotificationsModule` can import it without a cycle)
- Test: `backend/src/purchases/entitlements.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 tables; `ClockService`.
- Produces `EntitlementsService`:
  - `activate(tx: Tx, purchaseId: string): Promise<void>`: for each purchase line: `club_card` → `club_cards` row `{label: "<title> · <option>", valid_from: today, valid_until: durationMonths === 0 ? today : today + durationMonths months}`; `assigned` → `packages` row `{training_type, total: trainingCount}`.
  - `activeCard(memberId: string, db?): Promise<{ id: string; label: string; validUntil: string } | null>`: the card with the latest `valid_until >= today`.
  - `packagesOf(memberId: string, db?): Promise<PackageView[]>` with `PackageView = { id: string; trainingType: 'персональні' | 'спліт'; title: string; total: number; left: number; createdAt: string }`, `left = total - count(spends)`, oldest first.
  - `syncSpend(tx: Tx, bookingId: string): Promise<void>`: booking on an assigned slot with an attendance row and no spend → insert a spend on the oldest package of the member with that `training_type` and `left > 0` (lock the member's packages of that type `FOR UPDATE`); no attendance row → delete the spend; group slot → nothing.
  - `addManualCard(tx|db, memberId: string, trainerId: string, priceItemId: string): Promise<void>` (club_card items only, else 400).

- [ ] **Step 1: Failing tests** (mock db in the style of `prices.service.spec.ts`, queue of results per awaited query), with the clock pinned to `2026-10-23T12:00 Europe/Kyiv`:
  - `activate`: «Повний день · 3 місяці» → card `valid_from '2026-10-23'`, `valid_until '2027-01-23'`; «Разове відвідування» → both `'2026-10-23'`; «Персональне · 8 тренувань» → package `{training_type: 'персональні', total: 8}`.
  - `syncSpend` with attendance and packages `[{id:'old', left:0}, {id:'new', left:3}]` → spend on `'new'`.
  - `syncSpend` with attendance and an existing spend → no insert (✓ → ✗ keeps one spend).
  - `syncSpend` without attendance → deletes the spend (`«—»` returns it to that same package).
  - `syncSpend` with attendance and no package left → no insert, no error.
  - `syncSpend` on a group slot → no queries after the slot lookup.
- [ ] **Step 2: Run** `npx jest src/purchases` → FAIL.
- [ ] **Step 3: Implement** `EntitlementsService` with the signatures above.
- [ ] **Step 4: Run** → PASS; then `npm test`.
- [ ] **Step 5: Commit** `feat(purchases): activation, club cards, packages, spends`.

### Task 3: PaymentService pays purchases

**Files:**
- Modify: `backend/src/payment/payment.service.ts`, `payment.controller.ts`, `dto/create-checkout.dto.ts`, `payment.module.ts` (import `EntitlementsModule`)
- Test: `backend/src/payment/payment.service.spec.ts` (rewrite booking-based cases onto purchases; keep every LiqPay status case)

**Interfaces:**
- Consumes: `EntitlementsService.activate`.
- Produces:
  - `checkoutPurchase(purchaseId: string, memberId: string): Promise<{ data: string; signature: string } | { status: 'PAID' }>`: own `PENDING` `LIQPAY` purchase only (else 404 / 409). If it has a PENDING payment: reconcile with the status API like today's `resumePendingCheckout` (paid → `{status:'PAID'}`), else mark it `REPLACED` and create a new payment. Amount = `purchases.total_uah`; description `Motion Gym: <line titles joined with " + ">`.
  - `applyLiqpayStatus` success → payment `PAID` (CAS) **and** purchase `PENDING → PAID` (CAS, `decided_at = now`) **and** `activate()` in the same transaction; failure → payment `FAILED` + purchase `FAILED`; `expireStale()` → payment `EXPIRED` + purchase `EXPIRED`.
  - Callback `success` for a payment whose purchase is no longer `PENDING` (CANCELLED / EXPIRED / FAILED / already handled): no activation, save `raw_callback`, log `needs manual handling` (existing behaviour, purchase instead of booking). `REPLACED` payment of a still `PENDING` purchase is still accepted (old tab).
  - `getStatus(orderId, memberId)` joins `purchases.member_id`.
  - `POST /payments/checkout` body `{ purchaseId: uuid }`.
  - Removed: `PRICE_UAH`, slot checkout, booking `paymentStatus` writes, seat release in `cancelPayment`.
  - Legacy payments (`purchase_id IS NULL`): callbacks only log and save `raw_callback`; `expireStale()` ignores them.

- [ ] **Step 1: Rewrite the spec** onto purchases. Must include:
  - success callback → one `activate` call; the same callback again → no second `activate` (CAS lost);
  - callback and `getStatus` racing on one order → exactly one activation (Review Focus 1);
  - `success` after the purchase was `CANCELLED` → no activation, `raw_callback` saved, error log contains `needs manual handling` (Review Focus 2);
  - `try_again` / `phone_verify` / `payment_not_found` keep PENDING (existing cases);
  - `checkoutPurchase` on a CASH purchase → 404; on someone else's → 404; expired_date present, no `sandbox` key.
- [ ] **Step 2: Run** `npx jest src/payment` → FAIL.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** → PASS; `npm test` (fix schedule spec that mocked `expireStale` only if needed).
- [ ] **Step 5: Commit** `refactor(payment): LiqPay pays purchases; per-slot 700 ₴ checkout removed`.

### Task 4: Member purchase API

**Files:**
- Create: `backend/src/purchases/purchases.service.ts`, `purchases.controller.ts`, `dto/create-purchase.dto.ts`
- Create: `backend/src/purchases/purchases.module.ts` (imports `EntitlementsModule`, `PaymentModule`, `NotificationsModule`, `AuthModule`)
- Modify: `backend/src/app.module.ts`, `backend/src/notifications/notification.service.ts` (event `CASH_REQUESTED`), `schema.ts` only if a new notification type needs nothing (event_type has no CHECK)
- Test: `backend/src/purchases/purchases.service.spec.ts`

**Interfaces:**
- Consumes: `EntitlementsService`, `PaymentService.checkoutPurchase`, `NotificationService.enqueueAndProcess`.
- Produces (all `SessionGuard + MemberGuard`):
  - `GET /purchases` → `{ catalog: { clubCards: CatalogItem[]; services: CatalogItem[] }, card: {label, validUntil} | null, packages: PackageView[], pending: PurchaseView | null }`; `CatalogItem = { id, title, optionLabel, amountUah, trainingType?, trainingCount?, durationMonths? }`; `PurchaseView = { id, method, status, totalUah, createdAt, lines: {title, optionLabel, amountUah}[] }`.
  - `POST /purchases` `{ priceItemIds: string[] (1–2 uuids), method: 'LIQPAY' | 'CASH' }` → `{ purchaseId, checkout?: {data, signature} }`. Rules, in this order: unknown id → 404; a `group` item → 400; not exactly one `assigned` item or more than one `club_card` item → 400; no active card and no `club_card` item → 400 `Club card required`; member already has a `PENDING` purchase → 409 `You have an unpaid purchase`; `CASH` and `members.trainer_id` is null → 400 `No trainer to pay cash to`. Lines snapshot `title`, `option_label`, `amount_uah` from `price_items` now; `total_uah` = sum; `trainer_id` = member's trainer. `LIQPAY` → returns `checkout` from `checkoutPurchase`. `CASH` → push `CASH_REQUESTED` to that trainer: title `Оплата готівкою`, body `<displayName>: <total> ₴`, url `/admin/clients`, dedupe `cash-requested:<purchaseId>`; a failed push never fails the request.
  - `POST /purchases/:id/cancel` → own `PENDING` purchase → `CANCELLED` (CAS), its PENDING payments → `REPLACED`; else 404 / 409.

- [ ] **Step 1: Failing tests:** each validation rule above with its status code; price snapshot uses the DB amount even if the request had extra fields (DTO whitelist); `CASH` without trainer → 400 and nothing inserted (Review Focus 5); `CASH` → one `enqueueAndProcess('CASH_REQUESTED', …)` with the trainer id; push throwing → purchase still created.
- [ ] **Step 2: Run** `npx jest src/purchases` → FAIL.
- [ ] **Step 3: Implement** service, DTO (`IsArray`, `ArrayMinSize(1)`, `ArrayMaxSize(2)`, `IsUUID('all', {each: true})`, `IsIn(['LIQPAY','CASH'])`), controller, `CASH_REQUESTED` sender in `NotificationService` (to `findAdminByAdminId(trainerId)` only).
- [ ] **Step 4: Run** → PASS; `npm test`, lint, build.
- [ ] **Step 5: Commit** `feat(purchases): member catalog, purchase, cash request push`.

### Task 5: Trainer purchase API

**Files:**
- Create: `backend/src/purchases/admin-purchases.controller.ts`
- Modify: `purchases.service.ts`, `backend/src/admin/admin-schedule.service.ts` (`getMembers` summary)
- Test: `backend/src/purchases/admin-purchases.spec.ts`

**Interfaces:**
- Produces (all `SessionGuard + AdminGuard`):
  - `GET /admin/purchases/pending` → this trainer's `PENDING` `CASH` purchases: `PurchaseView & { memberId, displayName }`, oldest first.
  - `POST /admin/purchases/:id/confirm` → CAS `PENDING → PAID` where `method = 'CASH' AND trainer_id = me`, `decided_by = me`, `decided_at = now`, then `activate()` in the same tx. Not mine / not cash → 404; already decided → 409.
  - `POST /admin/purchases/:id/reject` → same guards, `→ REJECTED`, nothing activated.
  - `GET /admin/members/:id/purchases` (`visibleTo`) → `{ card, cards: {label, validFrom, validUntil, source: 'purchase' | 'manual'}[], packages: PackageView[], purchases: PurchaseView[] (last 20, with decidedBy username) }`.
  - `POST /admin/members/:id/club-card` `{ priceItemId }` (`visibleTo`) → `addManualCard`.
  - `GET /admin/members` rows gain `clubCardUntil: string | null` and `packagesLeft: { trainingType, left }[]` (only packages with `left > 0`).

- [ ] **Step 1: Failing tests:** confirm activates once; confirm twice → 409 and one activation; confirm another trainer's purchase → 404, not activated (Review Focus 5); reject → no activation; confirm a LIQPAY purchase → 404; manual card with an `assigned` item → 400.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; full `npm test`, lint, build.
- [ ] **Step 5: Commit** `feat(purchases): trainer confirms cash, sees client's card and packages`.

### Task 6: Assignment = booking; attendance spends

**Files:**
- Modify: `backend/src/admin/admin-schedule.service.ts` (`createAssignedSlot`, `updateSlotMembers`, `updateBookingAttendance`, `markAllAttendance`), `backend/src/notifications/internal-cron.controller.ts` (`autoConfirmAttendance`), `backend/src/schedule/schedule.service.ts` (`getAssignedSlots`), `admin-schedule.module.ts`, `schedule.module.ts`, `notifications.module.ts` (import `EntitlementsModule`)
- Test: `backend/src/admin/admin-assigned-slots.spec.ts`, `backend/src/schedule/schedule.service.spec.ts`

**Interfaces:**
- Consumes: `EntitlementsService.syncSpend`, `packagesOf`.
- Produces:
  - `createAssignedSlot` inserts an `ACTIVE` booking (no `paymentStatus`) per member and sets `booked_count` = members count.
  - `updateSlotMembers`: added member → booking; removed member → booking `CANCELLED` (no reason, so it is never shown as the member's); removed member whose booking has an attendance row → 409 `Attendance already marked`.
  - Every attendance write (single, «Підтвердити всіх», cron) calls `syncSpend(tx, bookingId)` in the same transaction. The cron writes `marked_by_admin_id` = the slot's `trainer_id` (not the first admin).
  - `AssignedSlotView` loses `myPaymentStatus`, gains `packageLeft: number` (sum of `left` of the member's packages of this slot's type; 0 = none).

- [ ] **Step 1: Failing tests:** create personal for Катя → one booking, `booked_count 1`; split for 3 → 3 bookings; remove a member without marks → booking cancelled; remove one with a mark → 409; `updateBookingAttendance('PRESENT')` → `syncSpend` called with that booking; `'UNMARKED'` → `syncSpend` called (returns the spend); cron → `markedByAdminId` equals the slot trainer and `syncSpend` per booking; schedule view returns `packageLeft`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; full suite, lint, build.
- [ ] **Step 5: Commit** `feat: assigning a member books them; attendance spends from the package`.

### Task 7: Member UI: «Мої покупки» and the purchase flow

**Files:**
- Create: `frontend/app/purchases/page.tsx`, `frontend/components/PurchaseFlow.tsx`
- Modify: `frontend/lib/api.ts`, `frontend/lib/liqpay.ts`, `frontend/components/AssignedSlotCard.tsx`, `frontend/components/PaymentResult.tsx`, `frontend/app/page.tsx` (link), `frontend/CLAUDE.md`

**Interfaces:**
- Consumes: Task 4 endpoints, `POST /payments/checkout {purchaseId}`.
- Produces: `submitLiqPay(checkout: {data: string; signature: string}): void` in `lib/liqpay.ts` (form POST, as today); `PRICE_UAH` and `redirectToLiqPay(slotId)` deleted. `api.getPurchases()`, `api.createPurchase(priceItemIds, method)`, `api.checkoutPurchase(purchaseId)`, `api.cancelPurchase(id)`; `AssignedSlotView.packageLeft`.

- [ ] **Step 1: `/purchases`** (`PageLayout variant="top"`): «Мої покупки», card status («Клубна карта» + `діє до DD.MM` / `немає` / `очікує оплати`), packages («залишилось N з M»), pending purchase (LIQPAY: «Оплатити» resumes checkout + «Скасувати»; CASH: «Тренер підтвердить, коли отримає готівку» + «Скасувати»), button «Купити тренування з тренером».
- [ ] **Step 2: `PurchaseFlow`** steps exactly as the mockup: service list grouped «Персональне» / «Спліт» → if no active card, «Спершу клубна карта» with the warning «У вас немає діючої клубної карти. Вона потрібна, щоб займатись у залі, і купується окремо від тренувань.» → «Оплата» summary with «Разом» → «Оплатити карткою · LiqPay» / «Оплачу готівкою тренеру» (hidden when the member has no trainer) → «Запит надіслано». `?type=персональні|спліт` pre-filters the service list.
- [ ] **Step 3: `AssignedSlotCard`:** no payment; `packageLeft > 0` → «з пакета · залишилось N»; `0` → link «Оплатити» to `/purchases?type=<type>`; cancel stays (reason modal, until start).
- [ ] **Step 4: `PaymentResult`:** copy refers to the purchase («✓ Оплату прийнято», failure text without «Місце за вами…», retry → `/purchases`).
- [ ] **Step 5: Verify:** `cd frontend && npx tsc --noEmit && npm run lint && npm run build`; no `gap-` in changed files.
- [ ] **Step 6: Commit** `feat(frontend): «Мої покупки» and purchase flow (club card first, LiqPay or cash)`.

### Task 8: Trainer UI: cash requests and client purchases

**Files:**
- Modify: `frontend/app/admin/clients/page.tsx`, `frontend/lib/api.ts`, `frontend/CLAUDE.md`
- Create: `frontend/components/admin/CashRequests.tsx`, `frontend/components/admin/MemberPurchases.tsx`

**Interfaces:**
- Consumes: Task 5 endpoints.

- [ ] **Step 1: `CashRequests`** at the top of «Клієнти» (hidden when empty): «Очікують оплати готівкою», per request name, lines, «Разом», buttons «Відхилити» / «Оплату отримано»; after either, the list reloads.
- [ ] **Step 2: Client row** shows `карта до DD.MM` (or «без карти») and `Перс. N · Спліт N` from `packagesLeft`; a «Покупки ▾» toggle opens `MemberPurchases`: card(s), packages with «N з M», history (method, status, who confirmed), «Додати карту вручну» (select of club items from the price list).
- [ ] **Step 3: Verify:** `npx tsc --noEmit && npm run lint && npm run build`.
- [ ] **Step 4: Commit** `feat(frontend): trainer confirms cash and sees client purchases`.

### Task 9: Docs

**Files:** `CLAUDE.md`, `TESTING.md`, `README.md`

- [ ] **Step 1: CLAUDE.md:** new `PurchasesModule` section (tables, rules from the spec, endpoints); rewrite `PaymentModule` bullets for purchases; LiqPay rules: replace "booking" with "purchase" where the rule is about what gets activated/cancelled, drop the `PRICE_UAH` rule; `PricesModule`: payments now read prices (snapshot at purchase); training types: assigned bookings are created by the trainer; attendance spends.
- [ ] **Step 2: TESTING.md:** rewrite sections 10 and 12 for purchases; new section «17. Покупки» covering: buy with no card (card step shown), with a card (skipped), LiqPay success, cash request → push to trainer → confirm / reject, member without trainer (no cash button), ✓ / ✗ / «—» spends and returns, two packages, cron spend, manual card, another trainer's request (404).
- [ ] **Step 3: README.md:** tables list and the feature line about payments.
- [ ] **Step 4: Commit** `docs: purchases (club cards, packages, cash and LiqPay)`.
