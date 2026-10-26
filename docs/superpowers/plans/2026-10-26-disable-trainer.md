# Вимкнення тренера — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На «Тренерах» будь-який тренер вимикає іншого: клієнти й готівкові оплати, що чекають, переходять до обраного тренера, тренування, що не закінчились, скасовуються, вимкнений не може увійти.

**Architecture:** Дві колонки в `admins`. Уся дія — один метод `AdminScheduleService.disableTrainer` в одній транзакції; він живе поруч зі скасуванням слотів, сповіщеннями й `getTrainers`/`assignTrainer`, тож спільне скасування слотів виноситься в приватний метод цього ж сервісу (відхилення від «`TrainersModule`» у дизайні: там немає ні скасування, ні сповіщень, і без цього довелося б дублювати правила). Фронтенд: кнопка й вікно на `/admin/trainers`, фільтр вимкнених у виборі тренера.

**Tech Stack:** NestJS 11, Drizzle ORM (Neon Postgres), Jest; Next.js 16, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-10-26-disable-trainer-design.md`

## Global Constraints

- Себе вимкнути не можна → 400 `Cannot disable yourself`; першого тренера (`getDefaultTrainerId`) → 400 `Cannot disable the first trainer`; `transferToId === id` → 400 `Cannot transfer to the same trainer`.
- `:id` немає → 404 `Trainer not found`; `transferToId` немає або вимкнений → 404 `Trainer not found`; уже вимкнений → 409 `Trainer already disabled` (compare-and-set, не «прочитати, потім оновити»).
- «Не закінчилось» = `slotStartsAt(localDate, slotTime).plus({ hours: 1 }) > clock.now()`. День **не** позначається CANCELLED.
- «Now» лише з `ClockService.now()`.
- Вимкнений тренер при вході отримує ту саму 401 `Invalid credentials`.
- UI-тексти українською; «клубна карта», без «пакет»; без `gap-*`; `npm run format` для зміненого фронту й бекенду.

## Review Focus

- Тренування вимкненого, яке йде зараз (почалось 30 хв тому): скасоване, крон 22:00 його не відмічає → тест у Task 2.
- Тренування, що закінчилось сьогодні годину тому: лишається активним із записами → тест у Task 2.
- Двоє тренерів одночасно вимикають одного: другий отримує 409, нічого не змінено вдруге → тест у Task 2 (compare-and-set повертає порожньо).
- Переназначення клієнта на вимкненого тренера через `PATCH /admin/members/:id/trainer` → 404 → тест у Task 1.
- Вимкнений тренер без збереженого розкладу, якому `loadTrainerSchedule` дає `LEGACY_DEFAULT`, не отримує нових тренувань: `ensureGroupSlots()` його пропускає → тест у Task 1.

---

### Task 1: База, вхід, список тренерів, переназначення, автододавання

**Files:**
- Modify: `backend/src/database/schema.ts` (`admins`)
- Modify: `backend/src/auth/auth.service.ts` (`loginAdmin`)
- Modify: `backend/src/admin/admin-schedule.service.ts` (`getTrainers`, `assignTrainer`)
- Modify: `backend/src/schedule/schedule.service.ts` (`ensureGroupSlots`: список тренерів)
- Test: `backend/src/admin/admin-assigned-slots.spec.ts`, `backend/src/trainers/trainer-invites.spec.ts` (вхід), `backend/src/schedule/schedule.service.spec.ts`

**Interfaces:**
- Produces: `admins.disabledAt` (`timestamp('disabled_at', { withTimezone: true })`, null), `admins.disabledByAdminId` (`uuid('disabled_by_admin_id')` → `admins.id`, null). `getTrainers()` повертає `{ id, username, createdAt, invitedBy, disabledAt: Date | null, disabledBy: string | null }`.

- [ ] **Step 1: Тести**
  - `loginAdmin` з рядком `{ ..., disabledAt: new Date() }` і правильним паролем → `UnauthorizedException('Invalid credentials')`.
  - `assignTrainer('trainer-1', M1, 'trainer-2')`, коли пошук тренера (тепер `WHERE id = … AND disabled_at IS NULL`) нічого не дає → `NotFoundException('Trainer not found')` (наявний тест «nobody» покриває форму; додати перевірку, що умова містить `disabled_at` — через `PgDialect().sqlToQuery` на `where`, як уже роблять тести цього файлу, або просто окремий кейс із порожнім результатом).
  - `getTrainers()` віддає `disabledAt` і `disabledBy` з рядка.
  - `ensureGroupSlots()` без `trainerId`: у мок-читанні тренерів лише невимкнені (перевірити, що запит тренерів має умову `disabled_at is null` через `PgDialect`), тож `loadTrainerSchedule` не викликається для вимкненого.
- [ ] **Step 2:** `cd backend && npx jest admin-assigned-slots trainer-invites schedule.service` → нові тести FAIL.
- [ ] **Step 3: Реалізація**
  - колонки в `admins` (коментар: хто й коли вимкнув; null = працює);
  - `loginAdmin`: `if (!admin || admin.disabledAt) throw new UnauthorizedException('Invalid credentials')` — до `bcrypt.compare` для вимкненого не обов'язково, але відповідь та сама;
  - `getTrainers`: другий alias `disabler`, поля `disabledAt`, `disabledBy: disabler.username`;
  - `assignTrainer`: пошук тренера з `isNull(admins.disabledAt)`;
  - `ensureGroupSlots`: `select … from(admins).where(isNull(admins.disabledAt))`.
- [ ] **Step 4:** `npm test` → усі PASS; `npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 5:** користувачка запускає `! cd backend && npm run db:push` (потрібен справжній термінал). Перевірити: `select column_name from information_schema.columns where table_name='admins'` містить `disabled_at`, `disabled_by_admin_id`.
- [ ] **Step 6: Commit** `feat(trainers): disabled_at on admins; a disabled trainer can't sign in or get clients`

### Task 2: `disableTrainer` і ендпоінт

**Files:**
- Modify: `backend/src/admin/admin-schedule.service.ts`
- Modify: `backend/src/admin/admin-schedule.controller.ts`
- Create: `backend/src/admin/dto/disable-trainer.dto.ts`
- Test: `backend/src/admin/admin-disable-trainer.spec.ts` (makeDb як у `admin-assigned-slots.spec.ts`)

**Interfaces:**
- Consumes: колонки з Task 1; `getDefaultTrainerId(db)`; `loadTrainerSchedule(db, id)`; `slotStartsAt`.
- Produces:
  - `private async cancelSlotsTx(tx: Tx, slotIds: string[]): Promise<void>` — `releaseMarks`, бронювання ACTIVE → CANCELLED (`cancelledAt`), слоти → `CANCELLED`, `bookedCount: 0`, `cancelledAt`. `updateSlot` і `cancelDay` переходять на нього (поведінка не змінюється; день CANCELLED лишається в `cancelDay`).
  - `async disableTrainer(adminId: string, trainerId: string, transferToId: string): Promise<{ movedClients: number; cancelledTrainings: number }>`
  - `POST /admin/trainers/:id/disable` (`ParseUUIDPipe`), тіло `DisableTrainerDto { @IsUUID() transferToId: string }`.

- [ ] **Step 1: Тести** (`now` = 2026-10-26 12:00 Kyiv)
  - `disableTrainer('t1', 't1', 't3')` → 400 `Cannot disable yourself`, без записів.
  - перший тренер (`getDefaultTrainerId` → `'t2'`) → 400 `Cannot disable the first trainer`.
  - `transferToId === trainerId` → 400.
  - `transferToId` не знайдено серед невимкнених → 404.
  - compare-and-set `UPDATE admins … WHERE id AND disabled_at IS NULL` повертає `[]` → 409, далі нічого не пишеться.
  - успіх: `sets` містять `{ disabledAt, disabledByAdminId: 't1' }`; `{ revokedAt }` для сесій; `{ trainerId: 't3' }` для `members` і для `purchases` (умова: `PENDING`, `CASH`, `trainer_id = t2` — перевірити через `PgDialect`); слоти `CANCELLED`; `{ autoCreate: false }` у `trainer_schedules` (upsert з `loadTrainerSchedule`); результат `{ movedClients, cancelledTrainings }`.
  - вибір слотів: серед слотів тренера `2026-10-26 11:30` (йде зараз) скасовується, `2026-10-26 10:30` (закінчився) — ні, `2026-10-27 19:00` — так; минулі дати не читаються (`local_date >= today`).
  - день: жоден `set` не містить `status: 'CANCELLED'` для `training_days`.
  - сповіщення: `notifications.enqueueAndProcess('SLOT_CANCELLED', 'slot-cancelled:<slotId>:<date>', { memberIds, slotTime, localDate })` лише для слотів із записами, після транзакції.
  - контролер: `SessionGuard, AdminGuard` (як `GUARDS_METADATA` у `trainer-invites.spec.ts`).
- [ ] **Step 2:** `npx jest admin-disable-trainer` → FAIL.
- [ ] **Step 3: Реалізація**
  - перевірки 400 до транзакції; читання `transferToId` (`isNull(disabledAt)`) і `:id` (немає → 404);
  - слоти: `trainingSlots` ⨝ `trainingDays`, `trainerId = :id`, `status = ACTIVE`, `localDate >= today`, потім фільтр «не закінчилось» у коді; записи цих слотів (memberId, slotId) читаються до транзакції для сповіщень, як у `cancelDay`;
  - транзакція: compare-and-set `admins` (порожньо → 409), `sessions` (`principalType = admin`, `principalId`, `revokedAt IS NULL`) → `revokedAt`, `members` → `trainerId = transferToId` (`returning` для лічильника), `purchases` PENDING CASH → `trainerId = transferToId`, `cancelSlotsTx`, upsert `trainer_schedules` (`bookingOpensAt` з `loadTrainerSchedule`, `autoCreate: false`, `updatedAt`) — часи не чіпати;
  - після: `SLOT_CANCELLED` по слотах із записами.
- [ ] **Step 4:** `npm test` → усі PASS (зокрема наявні тести `cancelDay` / `updateSlot`); `npx tsc --noEmit -p tsconfig.json`; `npm run lint`.
- [ ] **Step 5: Commit** `feat(trainers): disable a trainer — clients move to another, unfinished trainings cancelled`

### Task 3: Сторінка «Тренери» і вибір тренера

**Files:**
- Modify: `frontend/lib/api.ts` (`Trainer`: `disabledAt: string | null; disabledBy: string | null`; `disableTrainer(id, transferToId)` → `{ movedClients: number; cancelledTrainings: number }`)
- Modify: `frontend/app/admin/trainers/page.tsx`
- Modify: `frontend/app/admin/clients/page.tsx`, `frontend/app/admin/clients/[id]/page.tsx` (вибір тренера: `trainers.filter((t) => !t.disabledAt)`)

- [ ] **Step 1: «Усі тренери»**: біля рядка, що не я, не перший (найраніший `createdAt`) і не вимкнений — «Вимкнути». Вимкнений — позначка «вимкнено · {disabledBy} · {дата}», без кнопки.
- [ ] **Step 2: Вікно** (як модалка календаря): «Вимкнути {логін}?», `<select>` «Клієнти перейдуть до» (невимкнені, крім цього; за замовчуванням я), текст: «{логін} більше не зможе увійти. Усі його клієнти перейдуть до обраного тренера, готівкові оплати, що чекають, — теж. Тренування, що ще не закінчились, буде скасовано, записаним прийде сповіщення. Скасувати вимкнення не можна.», кнопки «Вимкнути» (`btn` небезпечна) і «Закрити». Помилки: 409 → «Цього тренера вже вимкнули», інше → «Не вдалося вимкнути. Спробуйте ще раз.».
- [ ] **Step 3:** після успіху — «Вимкнено. Клієнтів передано: N, тренувань скасовано: M», список перезавантажити.
- [ ] **Step 4:** `cd frontend && npm run format && npm run lint && npx tsc --noEmit -p .`; перевірити, що немає `gap-`.
- [ ] **Step 5: Commit** `feat(trainers): «Вимкнути» on the trainers page; disabled trainers not offered for clients`

### Task 4: Документи

**Files:** `CLAUDE.md`, `frontend/CLAUDE.md` (`/admin/trainers`), `TESTING.md` (розділ 19), `~/.claude/projects/-Users-admin-Sites-motionsportapp/memory/project_todo.md`

- [ ] **Step 1:** CLAUDE.md «Trainers — rules»: замінити «There is **no free trainer sign-up and no disabling of trainers** yet» на опис вимкнення (хто, що відбувається, 400/404/409, день не скасовується, `POST /admin/trainers/:id/disable`, вимкнений не входить і не пропонується). `AdminModule`: ендпоінт.
- [ ] **Step 2:** TESTING.md 19.9–19.13: вимкнути (клієнти в обраного, тренування, сповіщення, вхід неможливий, сесія на іншому пристрої закрита); себе / першого — кнопки немає; 409 при повторі; тренування, що йде зараз, скасоване, що закінчилось — ні; вимкненого немає у виборі тренера клієнта.
- [ ] **Step 3:** нотатка: «Вимкнення тренера» → зроблено 2026-10-26 (кратко як працює).
- [ ] **Step 4: Commit** `docs: disabling a trainer`
