# Активація карт і платні групові — Implementation Plan

**Goal:** Клубні карти, пакети тренера й групові абонементи діють з активації (карта — кнопкою тренера, пакет / абонемент — першою відміткою), згорають, якщо не активовані за місяць від покупки; групові стають платними (абонемент або разове, LiqPay або готівка); карту можна купити окремо.

**Architecture:** Групові абонементи — це `packages` з `training_type = 'групові'`, тож пакети тренера й абонементи мають один механізм: `activate_by`, `activated_on`, `valid_until`, списання в `syncSpend`. Правила дат — чисті функції в `purchases/validity.ts`. Запис на групове винесено в `tryBookGroup(tx, …)`, який використовують і `BookingService.book`, і активація покупки після LiqPay (у тій самій транзакції, без винятків: спершу перевірки, потім insert).

**Tech Stack:** NestJS 11, Drizzle ORM (Neon Postgres), Jest (мок-ланцюжки drizzle, як у `entitlements.service.spec.ts`), Next.js 16, Tailwind v4.

**Spec:** `docs/design/specs/2026-10-23-activation-and-group-passes-design.md` (продовжує `2026-10-23-purchases-design.md`).

## Global Constraints

- «Зараз» лише з `ClockService.now()` (Kyiv); дати — `YYYY-MM-DD` (`date` колонки), порівняння рядків ISO.
- Нове значення статусно-подібної колонки → додати в `oneOf()` у `schema.ts`; `db:push` запускає користувачка в терміналі (TTY). Ніколи не відповідати «truncate».
- Правила LiqPay з CLAUDE.md не змінюються: `applyLiqpayStatus` і переходи статусів не переписуються; нова логіка лише всередині `EntitlementsService.activate`.
- Усередині транзакції платежу нічого не кидає через бізнес-правила запису: unique violation (23505) зламав би транзакцію й оплату. Перевіряти до insert.
- «Місяць» = `DateTime.plus({ months: n })` до того ж числа, останній день включно (як `cardDates` зараз); `0` місяців = лише цей день.
- Дата покупки = день `purchases.created_at` у Kyiv (не день підтвердження).
- Фронтенд: без `gap-*`, лише токени з `globals.css`, усі виклики через `lib/api.ts`.
- Backend форматування: `npm run format` перед комітом (pre-commit відхиляє неформатоване).

## Review Focus

1. Відмітка в історії на тренуванні, датованому **до** покупки абонемента — заняття не знімається з цього абонемента (діапазон `[день покупки, кінець]`).
2. LiqPay-оплата прийшла, коли вікно запису вже закрилось / місць немає / вже є групове цього дня — оплата PAID, абонемент є, запису немає, транзакція не падає.
3. Дві відмітки одночасно на останнє заняття абонемента — знімається одне (блокування `FOR UPDATE` як зараз), і активація ставиться один раз.
4. «—» на першій відмітці не скидає `activated_on` / `valid_until`.
5. Готівка на групове відхилена — запис лишається ACTIVE, нічого не знімається; підтверджена після відмітки — заняття знімається саме з нового абонемента.

---

### Task 1: Схема, прайс і правила дат

**Files:**
- Create: `backend/src/purchases/validity.ts`, `backend/src/purchases/validity.spec.ts`
- Modify: `backend/src/database/schema.ts` (`priceItems`, `purchases`, `clubCards`, `packages`), `backend/src/prices/price-list.ts`, `backend/src/schedule/training-types.ts` (якщо треба константа `PASS_TYPES`)

**Interfaces:**
- Produces:
  - `schema.clubCards`: `validFrom`, `validUntil` стають nullable (null = чекає активації); нові `durationMonths integer NOT NULL default 0`, `activateBy date NOT NULL`.
  - `schema.packages`: нові `durationMonths integer NOT NULL default 1`, `purchasedOn date NOT NULL`, `activateBy date NOT NULL`, `activatedOn date` (null), `validUntil date` (null); CHECK `packages_training_type_check` на `PASS_TYPES = [GROUP_TYPE, ...ASSIGNED_TYPES]`.
  - `schema.purchases`: `slotId uuid → training_slots.id` (null), `bookingId uuid → bookings.id` (null).
  - `price_items_training_type_check` на `PASS_TYPES`; `PriceListItem.trainingType` допускає `'групові'`.
  - `validity.ts`:
    - `activateByFor(purchasedOn: string): string` — `purchasedOn + 1 month`.
    - `validUntilFor(activatedOn: string, months: number): string`.
    - `type PassDates = { purchasedOn: string; activateBy: string; activatedOn: string | null; validUntil: string | null }`
    - `passUsableOn(p: PassDates, date: string): boolean` — не активований: `purchasedOn ≤ date ≤ activateBy`; активований: `purchasedOn ≤ date ≤ validUntil`.
    - `type CardState = 'waiting' | 'active' | 'expired' | 'burned'`; `cardState(c: { activateBy: string; validFrom: string | null; validUntil: string | null }, today: string): CardState`.
    - `type PassState = 'waiting' | 'active' | 'expired' | 'burned' | 'used'`; `passState(p: PassDates & { left: number }, today: string): PassState` (`used` коли `left === 0`, має пріоритет).

- [ ] **Step 1: Write the failing tests** `validity.spec.ts`:
  - `activateByFor('2026-10-23') === '2026-11-23'`; `activateByFor('2026-01-31') === '2026-02-28'`.
  - `validUntilFor('2026-10-23', 1) === '2026-11-23'`, `validUntilFor('2026-10-23', 0) === '2026-10-23'`.
  - `passUsableOn` неактивований (`purchasedOn '2026-10-23'`, `activateBy '2026-11-23'`): true для `'2026-10-23'` і `'2026-11-23'`, false для `'2026-10-22'` і `'2026-11-24'`.
  - активований (`activatedOn '2026-11-01'`, `validUntil '2026-12-01'`): true для `'2026-12-01'`, false для `'2026-12-02'`, true для `'2026-10-25'` (після покупки, до активації — ретро-відмітка), false для `'2026-10-22'`.
  - `cardState`: waiting (validFrom null, today ≤ activateBy), burned (validFrom null, today > activateBy), active (today ≤ validUntil), expired.
  - `passState`: `used` коли `left 0` навіть якщо дати дійсні.
- [ ] **Step 2:** `cd backend && npx jest validity` → FAIL (module not found).
- [ ] **Step 3: Implement** `validity.ts` (luxon `DateTime.fromISO(d, { zone: KY_ZONE }).plus({ months }).toISODate()`), схему й прайс:
  - `price-list.ts`: усі `assigned` → `durationMonths: 1`; `group_single` → `trainingType: 'групові', trainingCount: 1, durationMonths: 1`; `group_10` → `trainingType: 'групові', trainingCount: 10, durationMonths: 1`. Оновити коментарі (`durationMonths` = строк від активації).
  - Коментарі в схемі: що означають null-дати.
- [ ] **Step 4:** `npx jest validity` → PASS; `npx tsc --noEmit` → чисто. Місця, що читають `clubCards.validFrom/validUntil` як not-null і пишуть нові NOT NULL колонки (`activate`, `addManualCard`, `activeCard`, `summaries`, `memberPurchases`), виправити мінімально тут (тимчасово писати `activateBy`/`purchasedOn` = сьогодні + місяць); поведінку міняє Task 2. `npm test` → зелено.
- [ ] **Step 5: Попросити користувачку** запустити в терміналі `cd backend && npm run db:push` і `npm run seed:prices` (метадані груп і строків). Тестові рядки `club_cards` / `packages` без нових NOT NULL колонок: якщо drizzle питає про default / truncate для `activate_by` / `purchased_on` — не truncate; додати тимчасовий SQL-default у схему (`default(sql\`CURRENT_DATE\`)`) або попросити дозволу видалити тестові рядки покупок (дані тестові, але видалення — лише з її згоди).
- [ ] **Step 6: Commit** `feat(purchases): activation dates for cards and packages, group passes in the price list`

### Task 2: EntitlementsService — стани, активація, списання

**Files:**
- Modify: `backend/src/purchases/entitlements.service.ts`, `backend/src/purchases/entitlements.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`validity.ts`, нові колонки).
- Produces:
  - `activate(tx, purchaseId): Promise<void>` — карта: `validFrom/validUntil` null, `durationMonths`, `activateBy = activateByFor(purchasedOn)`; пакет будь-якого `PASS_TYPES`: `purchasedOn`, `activateBy`, `durationMonths` (з `price_items.duration_months ?? 1`), без активації. `purchasedOn` = Kyiv-день `purchases.created_at` (додати в select). Після створення — Task 4 додає запис і прив'язку (тут лише створення).
  - `usableCard(memberId, db?) → { id, label, state: 'waiting' | 'active', validUntil: string | null, activateBy: string } | null` — замінює `activeCard`; пріоритет `active` з найпізнішим `validUntil`, інакше найраніший `waiting`.
  - `packagesOf(memberId, db?) → PackageView[]`, `PackageView` += `trainingType: 'групові' | 'персональні' | 'спліт'`, `state: PassState`, `activateBy`, `activatedOn`, `validUntil`.
  - `summaries(memberIds)` → `{ clubCard: { state: 'waiting' | 'active'; until: string } | null; packagesLeft: { trainingType; left }[] }` (`until` = `validUntil` або `activateBy`; `packagesLeft` лише з пакетів у стані `waiting` / `active`).
  - `groupPassLeft(memberId, date, db?) → number` — сума `left` групових пакетів, `passUsableOn(date)`.
  - `syncSpend(tx, bookingId)` — для будь-якого типу з `PASS_TYPES`; кандидати: пакети члена цього типу `FOR UPDATE`, далі окремий підрахунок спендів (як зараз), фільтр `passUsableOn(p, slotDate)` і `left > 0`; порядок: спершу пакет, чия покупка має `purchases.booking_id = bookingId`, далі `createdAt asc`. Якщо вибраний не активований → `UPDATE packages SET activated_on = slotDate, valid_until = validUntilFor(slotDate, durationMonths) WHERE id = … AND activated_on IS NULL`. «—» видаляє спенд, активацію не чіпає.
  - `activateCard(db, memberId, cardId) → void` — `UPDATE club_cards SET valid_from = today, valid_until = validUntilFor(today, duration_months) WHERE id AND member_id AND valid_from IS NULL AND activate_by >= today RETURNING id`; нема рядка → якщо карти немає 404, інакше 409 `Card cannot be activated`.
  - `addManualCard(db, memberId, trainerId, priceItemId, activateNow: boolean)` — `activateBy = activateByFor(today)`; `activateNow` → одразу дати.

- [ ] **Step 1: Failing tests** (той самий `makeDb`):
  - `a paid club card waits for activation: no dates, activate_by a month after the purchase day` — values `{ validFrom: null, validUntil: null, durationMonths: 3, activateBy: '2026-11-23' }` при `created_at` 2026-10-23.
  - `a group pass is a package of type групові, not activated` — `{ trainingType: 'групові', total: 10, purchasedOn: '2026-10-23', activateBy: '2026-11-23', durationMonths: 1 }`.
  - `the first mark activates the package from the training date` — update з `activatedOn = slotDate`, `validUntil = slotDate + 1 month`.
  - `a package already activated is not re-activated` (жодного update packages).
  - `a training dated before the purchase is not paid by that pass` (нема insert у `packageSpends`).
  - `a burned pass pays nothing` (дата тренування > activateBy, не активований).
  - `a group training spends from a group pass` (замінює старий тест «a group training spends nothing»).
  - `the pass bought for this booking pays first, even when an older one has trainings left`.
  - `«—» gives the training back and keeps the activation` (delete спенду, без update packages).
  - `activateCard: 409 for a burned or already active card; sets today + duration for a waiting one`.
  - `manual card with activateNow has dates from today; without — waits`.
  - `usableCard: a waiting card counts, a burned one does not`.
- [ ] **Step 2:** `npx jest entitlements` → нові FAIL.
- [ ] **Step 3: Implement.** `activeCard` перейменувати на `usableCard` і оновити виклики (`purchases.service.ts`), щоб `tsc` був чистий.
- [ ] **Step 4:** `npx jest entitlements` → PASS; `npm test` → зелено (поправити тести `purchases.service.spec.ts`, що мокали `activeCard`).
- [ ] **Step 5: Commit** `feat(purchases): cards wait for the trainer, packages start on the first mark and burn`

### Task 3: Запис на групове вимагає абонемент; `tryBookGroup`

**Files:**
- Create: `backend/src/booking/group-booking.ts`
- Modify: `backend/src/booking/booking.service.ts`, `backend/src/booking/booking.module.ts` (import `EntitlementsModule`), `backend/src/booking/booking.service.spec.ts` (або наявний spec запису)

**Interfaces:**
- Consumes: `EntitlementsService.groupPassLeft` (Task 2).
- Produces:
  - `type GroupBookingResult = { ok: true; bookingId: string } | { ok: false; reason: 'NOT_FOUND' | 'CANCELLED' | 'NOT_SCHEDULED' | 'WINDOW' | 'FULL' | 'ALREADY_BOOKED' }`
  - `tryBookGroup(tx: Tx, now: DateTime, memberId: string, slotId: string): Promise<GroupBookingResult>` — без винятків: lock member, lock slot `FOR UPDATE`, group + ACTIVE + день SCHEDULED + свій тренер (`getMemberTrainerId`) + вікно 14:00–21:00 + місце + `findGroupBooking`; insert booking + `booked_count + 1`. Повертає `bookingId`.
  - `BookingService.book` використовує `tryBookGroup` і мапить причини на наявні винятки й тексти (`Slot not found`, `Booking opens at 14:00` / `Booking window has closed` — WINDOW мапиться на той з двох, що відповідає `now`, `Slot is full`, `You already have an active booking for this day`). Перед транзакцією: `groupPassLeft(memberId, day.localDate) === 0` → `409 Group pass required`.

- [ ] **Step 1: Failing tests:** `book without a group pass → 409 Group pass required, nothing inserted`; `book with a pass that has trainings left books as before`; `tryBookGroup returns FULL / ALREADY_BOOKED / WINDOW instead of throwing`; наявні тести запису лишаються зеленими (додати мок `groupPassLeft → 1`).
- [ ] **Step 2:** `npx jest booking` → FAIL.
- [ ] **Step 3: Implement**, перенести `findGroupBooking` / перевірку вікна в `group-booking.ts` (BookingService.switchSlot використовує їх звідти). `switchSlot` абонемент не перевіряє.
- [ ] **Step 4:** `npx jest booking` → PASS; `npm test` → зелено.
- [ ] **Step 5: Commit** `feat(booking): group trainings need a group pass`

### Task 4: Покупки — карта окремо, групові, запис після оплати, активація карти тренером

**Files:**
- Modify: `backend/src/purchases/purchases.service.ts`, `dto/create-purchase.dto.ts`, `dto/add-club-card.dto.ts`, `admin-purchases.controller.ts`, `entitlements.service.ts` (`activate` + запис), `backend/src/payment/payment.service.ts` (`getStatus` += `booked`), specs: `purchases.service.spec.ts`, `admin-purchases.spec.ts`, `entitlements.service.spec.ts`, `payment.service.spec.ts`

**Interfaces:**
- Consumes: Task 2, Task 3 (`tryBookGroup`).
- Produces:
  - `CreatePurchaseDto` += `@IsOptional() @IsUUID('all') slotId?: string`.
  - `create()` дозволені набори: `[group]`; `[club_card]`; `[club_card, assigned]`; `[assigned]` з `usableCard`. Інакше 400 `Not a valid set of items`. `[assigned]` без карти → 400 `Club card required` (як зараз). `slotId` лише з `[group]`, інакше 400.
  - Готівка + `[group]` + `slotId`: у тій самій транзакції після insert покупки — `tryBookGroup`; `ok: false` → кинути відповідний виняток (тексти як у `book`), транзакція відкочується; `ok` → `purchases.booking_id = bookingId`. Пуш тренеру як зараз.
  - LiqPay + `slotId`: зберегти `purchases.slot_id`, запису поки немає.
  - `EntitlementsService.activate`: після створення пакета — якщо `slot_id` є й `booking_id` null → `tryBookGroup(tx, now, memberId, slotId)`; `ok` → зберегти `booking_id`; не `ok` → лог `Purchase ${id}: paid, not booked (${reason})`, без винятку. Потім, якщо `booking_id` є → `syncSpend(tx, booking_id)` (знімає з нового пакета, якщо відмітка вже стоїть).
  - `getForMember` → `catalog.groupPasses` (розділ `group`), `card: usableCard`, `packages` з `state`.
  - `PaymentService.getStatus` → додатково `booked?: boolean` для PAID-покупки з `slot_id` (`booking_id != null`).
  - `POST /admin/members/:memberId/club-cards/:cardId/activate` → `activateCard` (через `visibleMember`). `AddClubCardDto` += `@IsOptional() @IsBoolean() activate?: boolean`.
  - `memberPurchases().cards[]` += `id`, `state: CardState`, `activateBy`.

- [ ] **Step 1: Failing tests:**
  - `a club card alone can be bought` (LiqPay checkout викликано, один рядок).
  - `a group pass is bought alone; with a card or a service → 400`.
  - `slotId with a non-group item → 400`.
  - `cash for a group pass books the slot at once and remembers the booking`.
  - `cash for a group pass: a full slot → 409, no purchase left` (транзакція кинула).
  - `LiqPay group purchase remembers the slot, books nothing yet`.
  - `activation books the remembered slot and spends from the new pass if already marked`.
  - `activation that cannot book (window closed) still activates the pass and does not throw`.
  - `rejecting group cash keeps the booking` (жодного update bookings).
  - `trainer activates a waiting card of a visible client; another trainer's client → 404`.
  - `getStatus reports booked for a paid slot purchase`.
- [ ] **Step 2:** `npx jest purchases payment entitlements` → FAIL.
- [ ] **Step 3: Implement.** Якщо `EntitlementsService` імпортує `tryBookGroup` з `booking/`, переконатися, що це звичайний модуль-функція (без Nest DI), щоб не було циклу модулів.
- [ ] **Step 4:** `npm test` → зелено; `npm run lint` → чисто.
- [ ] **Step 5: Commit** `feat(purchases): buy a card alone, group passes with booking, trainer activates cards`

### Task 5: Розклад для клієнта

**Files:**
- Modify: `backend/src/schedule/schedule.service.ts`, його spec

**Interfaces:**
- Produces: `GET /schedule/next` += `groupPassLeft: number` (`groupPassLeft(memberId, localDate)`, 0 для гостя чи без дня) і `canPayCash: boolean` (у члена є тренер). `myPaymentStatus` у групових слотах прибрати (застаріле, лишки per-training оплати) — разом із полем у фронтенд-типі в Task 6.

- [ ] **Step 1: Failing test:** `schedule tells the member how many group trainings their pass has for that day`.
- [ ] **Step 2:** `npx jest schedule` → FAIL. **Step 3:** implement. **Step 4:** `npm test` → зелено.
- [ ] **Step 5: Commit** `feat(schedule): group pass left on the member's schedule`

### Task 6: Фронтенд

**Files:**
- Create: `frontend/components/GroupPassModal.tsx`
- Modify: `frontend/lib/api.ts`, `frontend/components/SlotCard.tsx`, `frontend/app/page.tsx`, `frontend/components/MyPurchasesPage.tsx`, `frontend/components/PurchaseFlow.tsx`, `frontend/components/admin/MemberPurchases.tsx`, `frontend/app/admin/clients/page.tsx`, `frontend/components/PaymentResult.tsx`

**Interfaces:**
- Consumes: API з Task 4–5.
- Produces (`api.ts`): `ScheduleNext.groupPassLeft`, `ScheduleNext.canPayCash`; `CatalogItem` для груп; `ClubCard` += `id`, `state`, `activateBy`; `TrainingPackage.state`, `activateBy`, `activatedOn`, `validUntil`, `trainingType: TrainingType`; `AdminMember.clubCard`; `api.createPurchase({ priceItemIds, method, slotId? })`; `api.activateClubCard(memberId, cardId)`; `api.addClubCard(memberId, priceItemId, activate)`; статус оплати += `booked?: boolean`.

Поведінка й тексти:
- `SlotCard`: «Записатися» при `groupPassLeft === 0` відкриває `GroupPassModal` (кнопки «Купити разово · 250 ₴», «Купити абонемент · 10 занять · 2200 ₴», «Оплата готівкою» — лише при `canPayCash`; суми з каталогу `GET /purchases`). «Оплата готівкою» → вибір «Разове» / «Абонемент» → `createPurchase({method:'CASH', slotId})`, після успіху оновити розклад (людина записана), текст «Записано. Оплатіть тренеру в залі.». LiqPay → `createPurchase({method:'LIQPAY', slotId})` → `submitLiqPay`. 409 `Group pass required` від `api.book` теж відкриває модалку.
- `PaymentResult`: PAID + `booked === true` → «Оплачено, ви записані»; `booked === false` → «Оплачено. Записатися не вдалося (місць немає або запис закрито) — абонемент збережено».
- `MyPurchasesPage`: карта — «чекає активації до DD.MM» / «діє до DD.MM»; пакети й абонементи з `state` (`waiting` «не активовано, до DD.MM», `active` «до DD.MM · залишилось N з M»); кнопки «Купити клубну карту», «Купити групові», «Купити тренування з тренером». `PurchaseFlow` підтримує режими `card` (лише вибір карти) і `group` (разове / абонемент).
- `MemberPurchases` (тренер): у кожної карти стан; у `waiting` кнопка «Активувати з сьогодні»; ручне додавання — «Додати» і «Додати й активувати з сьогодні»; `burned` — «не активована, згоріла».
- Клієнти: `карта до DD.MM` / `карта чекає активації` / `без карти`; `TYPE_SHORT` += `групові: "гр"`.

- [ ] **Step 1:** `cd frontend && npx tsc --noEmit` після зміни типів → помилки в місцях використання (це «red»).
- [ ] **Step 2:** implement компоненти.
- [ ] **Step 3:** `npx tsc --noEmit` → чисто; `npm run lint` → чисто; `grep -rn "gap-" components app` → нічого нового.
- [ ] **Step 4:** запустити `npm run dev` (frontend + backend) і пройти: гість без абонемента → модалка; готівка → записано, у тренера запит; тренер активує карту. Скріншот не обов'язковий, але сценарії — так.
- [ ] **Step 5: Commit** `feat(web): group pass modal, card states and activation`

### Task 7: Документація

**Files:** `CLAUDE.md`, `TESTING.md`, `README.md` (якщо згадує безкоштовні групові)

- [ ] **Step 1:** CLAUDE.md: `PurchasesModule` (дозволені набори, `slotId`, активація, згоряння, `PASS_TYPES`, `tryBookGroup`), «Training types — rules» (групові платні, абонемент обов'язковий, без карти), прайс (`group` тепер продається; `duration_months` = від активації), «Deliberate copies» (`activated_on`/`valid_until`).
- [ ] **Step 2:** TESTING.md розділ 17: сценарії з Review Focus + модалка, готівка, активація карти, згоряння (через `ClockService` у тестах / зміну дат у БД вручну).
- [ ] **Step 3:** `grep -n "безкоштов\|free" CLAUDE.md TESTING.md README.md` — лише актуальне.
- [ ] **Step 4: Commit** `docs: activation and paid group trainings`
