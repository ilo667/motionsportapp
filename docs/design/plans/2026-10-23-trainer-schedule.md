# Регулярний розклад тренера — план реалізації

**Goal:** Кожен тренер на сторінці «Мій розклад» задає дні, час групових і час відкриття запису; програма створює його групові на 3 тижні вперед, запис відкривається о його часі й закривається на початку кожного тренування.

**Architecture:** Налаштування — дві таблиці (`trainer_schedules`, `trainer_schedule_times`) і чисті правила в `backend/src/trainer-schedule/rules.ts`. Читання налаштувань — проста функція `loadTrainerSchedule(db, trainerId)` (як `getMemberTrainerId`), щоб Booking/Schedule/Admin/Cron брали її без циклу модулів. Перший тренер без збережених налаштувань отримує теперішні (Пн/Ср/Пт 19:00, 20:00, 14:00, автостворення увімкнене) — без скрипта міграції.

**Tech Stack:** NestJS 11, Drizzle + Neon, Luxon (Europe/Kyiv), Jest (ланцюгові моки drizzle, як у сусідніх spec), Next.js 16, Tailwind v4.

**Spec:** `docs/design/specs/2026-10-23-trainer-schedule-design.md`

## Global Constraints

- День тижня — як у Luxon: 1 = Пн … 7 = Нд.
- Час групового: від `06:00` до `21:00` включно, крок 15 хв; два групові одного тренера в один день — щонайменше 60 хв одне від одного.
- Час відкриття запису — один на всі дні, у день тренування, строго раніше за найраніше групове розкладу. За замовчуванням `14:00`.
- Закриття запису, скасування і перехід — до початку тренування (`slotStartsAt`).
- Горизонт автостворення — 21 день (`DEFAULT_HORIZON_DAYS`), місць 8.
- Автостворення лише додає: існуючий час (навіть скасований) не чіпає; пропускає `CANCELLED` день і день, де в тренера є скасоване групове і немає активного групового.
- Перший тренер (`getDefaultTrainerId`) без збережених налаштувань: дні `[1,3,5]`, час `['19:00','20:00']`, відкриття `14:00`, `autoCreate: true`. Інші без налаштувань: порожньо, `14:00`, `autoCreate: false`.
- Пуш відкриття: `dedupe_key` = `booking-open:<YYYY-MM-DD>:<trainerId>`; йде, якщо `opensAt ≤ now < початок першого групового тренера сьогодні`.
- Тексти UI: «клубна карта», без «пакет», без «LiqPay»; без пояснювальних абзаців. Фронтенд: без `gap-*`, лише токени; prettier перед комітом (`npm run format` у `frontend/`, `npm run format` у `backend/`).
- Новий CHECK у схемі → `oneOf`/`check`; після схеми `npm run db:push` (спільна dev-база; ніколи не «truncate»).

## Review Focus

1. Клієнт без тренера — бачить групові першого тренера, отже вікно й пуш за налаштуваннями першого тренера (`getMemberTrainerId`) — тест у Task 3 і Task 4.
2. Тренер змінив час відкриття після того, як тренування створено — вікно бере новий час (не збережений у слоті) — тест у Task 3.
3. Перехід 19:00 → 20:00 о 19:10 (старе вже почалося) — 400 `Training has already started`; перехід на тренування, що почалося — теж — тест у Task 3.
4. Тренер прибрав день із розкладу — уже створені тренування того дня лишаються; «Скасувати мої тренування цього дня» + новий час у розкладі — день не відроджується — тест у Task 2.
5. День із груповими 10:00 і 19:00: о 12:00 запис на 10:00 закритий, на 19:00 відкритий; «наступне тренування» лишається цим днем до 19:00 — тест у Task 3.

---

### Task 1: Налаштування розкладу — схема, правила, читання й збереження

**Files:**
- Modify: `backend/src/database/schema.ts` (дві таблиці)
- Create: `backend/src/trainer-schedule/rules.ts`, `rules.spec.ts`
- Create: `backend/src/trainer-schedule/trainer-schedule.store.ts` (`loadTrainerSchedule`)
- Create: `backend/src/trainer-schedule/trainer-schedule.service.ts`, `trainer-schedule.controller.ts`, `trainer-schedule.module.ts`, `dto/save-schedule.dto.ts`, `trainer-schedule.service.spec.ts`
- Modify: `backend/src/app.module.ts` (імпорт модуля)

**Interfaces:**
- Produces:
  - `type TrainerSchedule = { bookingOpensAt: string; autoCreate: boolean; times: { weekday: number; slotTime: string }[] }` (times відсортовані за weekday, slotTime)
  - `rules.ts`: `GROUP_EARLIEST = '06:00'`, `GROUP_LATEST = '21:00'`, `GROUP_MIN_GAP_MINUTES = 60`, `DEFAULT_OPENS_AT = '14:00'`, `LEGACY_DEFAULT: TrainerSchedule`; `groupTimeError(slotTime: string, sameDayTimes: string[]): string | null`; `scheduleError(s: TrainerSchedule): string | null`; `bookingOpensAt(localDate: string, opensAt: string): DateTime`
  - `loadTrainerSchedule(db: Db | Tx, trainerId: string): Promise<TrainerSchedule>`
  - `GET /admin/my-schedule` → `TrainerSchedule`; `PUT /admin/my-schedule` body `TrainerSchedule` → `TrainerSchedule` (400 з текстом помилки правил)
  - `TrainerScheduleService.save(trainerId, s)` після запису викликає `ScheduleService.ensureGroupSlots(trainerId, { force: true })` (Task 2; до Task 2 — без виклику)

- [ ] **Step 1: Тести правил (`rules.spec.ts`)**

```ts
expect(groupTimeError('05:45', [])).toBe('Group trainings are from 06:00 to 21:00');
expect(groupTimeError('21:15', [])).toBe('Group trainings are from 06:00 to 21:00');
expect(groupTimeError('19:10', [])).toBe('Time must be in 15-minute steps');
expect(groupTimeError('19:30', ['19:00'])).toBe('Group trainings must be at least an hour apart');
expect(groupTimeError('20:00', ['19:00'])).toBeNull();
expect(scheduleError({ bookingOpensAt: '19:00', autoCreate: true, times: [{ weekday: 1, slotTime: '19:00' }] }))
  .toBe('Booking must open before the first training');
expect(scheduleError({ bookingOpensAt: '14:00', autoCreate: true, times: [{ weekday: 8, slotTime: '19:00' }] }))
  .toBe('Unknown weekday');
expect(scheduleError(LEGACY_DEFAULT)).toBeNull();
expect(bookingOpensAt('2026-10-26', '14:00').toISO()).toBe('2026-10-26T14:00:00.000+02:00');
```

- [ ] **Step 2:** `npx jest src/trainer-schedule/rules.spec.ts` → FAIL (module not found).
- [ ] **Step 3: Реалізувати `rules.ts`.** `scheduleError` перевіряє кожен день через `groupTimeError` (дублікати часу в дні — теж помилка «at least an hour apart»), формат `HH:MM` для `bookingOpensAt` і крок 15 хв.
- [ ] **Step 4:** тест → PASS.
- [ ] **Step 5: Схема.** `trainer_schedules` (`trainer_id` uuid PK → admins, `booking_opens_at` text not null default `'14:00'`, `auto_create` boolean not null default false, `updated_at`) і `trainer_schedule_times` (`trainer_id` → admins, `weekday` integer, `slot_time` text; PK `(trainer_id, weekday, slot_time)`; `check('trainer_schedule_times_weekday_check', sql\`weekday between 1 and 7\`)`).
- [ ] **Step 6: Тести сервісу (`trainer-schedule.service.spec.ts`)**, мок як у `admin-purchases.spec.ts`:
  - `loadTrainerSchedule` — рядок є → його значення; рядка немає і це перший тренер → `LEGACY_DEFAULT`; рядка немає, інший тренер → `{ bookingOpensAt: '14:00', autoCreate: false, times: [] }`.
  - `save` з помилкою правил → `BadRequestException('Booking must open before the first training')`, нічого не записано.
  - `save` валідного → upsert `trainer_schedules`, delete + insert `trainer_schedule_times` в одній транзакції; повертає збережене.
  - контролер під `SessionGuard, AdminGuard`.
- [ ] **Step 7:** FAIL → реалізувати store/service/controller/DTO (`class-validator`: `bookingOpensAt` `Matches(/^\d{2}:\d{2}$/)`, `autoCreate` boolean, `times` масив ≤ 7×16 з `weekday` Int 1–7 і `slotTime` `Matches`) → PASS.
- [ ] **Step 8:** `npm test`, `npm run lint`, `npx tsc --noEmit` — зелено. `npm run db:push` (нові таблиці, питань бути не повинно).
- [ ] **Step 9: Commit** `feat(schedule): trainer schedule settings (GET/PUT /admin/my-schedule)`.

### Task 2: Автостворення групових для кожного тренера

**Files:**
- Modify: `backend/src/schedule/schedule.service.ts` (`ensureDefaultGroupSlots` → `ensureGroupSlots`)
- Modify: `backend/src/schedule/training-types.ts` (прибрати `GROUP_SLOT_TIMES`, якщо більше ніде; `DEFAULT_WEEKDAYS` → `LEGACY_DEFAULT`)
- Modify: `backend/src/trainer-schedule/trainer-schedule.service.ts` (виклик після save; `ScheduleModule` експортує `ScheduleService`, перевірити цикл модулів)
- Test: `backend/src/schedule/group-slots.spec.ts` (новий)

**Interfaces:**
- Consumes: `loadTrainerSchedule`, `TrainerSchedule` (Task 1)
- Produces: `ScheduleService.ensureGroupSlots(trainerId?: string, opts?: { force?: boolean }): Promise<void>` — без `trainerId` для всіх тренерів з `autoCreate` (раз на добу на інстанс, як зараз); `force` ігнорує цей кеш.

- [ ] **Step 1: Тести**
  - тренер з `times` Пн 10:00, Ср 19:00, `autoCreate: true` → вставлено слоти лише на Пн/Ср горизонту, `trainerId` цього тренера, `capacity: 8`, `onConflictDoNothing`.
  - `autoCreate: false` → нічого не вставлено.
  - день, де в тренера є `CANCELLED` групове і немає `ACTIVE` групового → пропущений (Review Focus 4); день `CANCELLED` → пропущений.
  - день, де в тренера одне групове скасоване, а інше активне → не пропущений (скасований час лишається скасованим завдяки конфлікту).
  - `force: true` двічі за день → двічі вставляє; без `force` — один раз.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Реалізувати.** Для кожного тренера: дати горизонту за `weekday`; `insert(trainingDays).onConflictDoNothing()`; вибрати дні `SCHEDULED`; виключити дні з правилом вище (один запит по `training_slots` цього тренера на ці дні, групові, `status`); вставити слоти. `getNext` викликає `ensureGroupSlots()`.
- [ ] **Step 4:** PASS; `npm test` зелено.
- [ ] **Step 5: Commit** `feat(schedule): group trainings created from each trainer's schedule`.

### Task 3: Вікно запису: відкриття тренера, закриття на початку тренування

**Files:**
- Modify: `backend/src/booking/group-booking.ts` (`groupBookingWindow` → нова сигнатура), `booking.service.ts` (book / cancel / switch), `schedule/schedule.service.ts` (`getNext`), `admin/admin-schedule.service.ts` (`getSchedule`)
- Test: `booking/group-booking.spec.ts`, `booking/booking.service.spec.ts` (або сусідній spec, де вже тестується book/switch), `schedule/schedule.service.spec.ts`

**Interfaces:**
- Consumes: `loadTrainerSchedule`, `bookingOpensAt` (Task 1)
- Produces:
  - `groupBookingWindow(localDate: string, slotTime: string, opensAt: string): { openAt: DateTime; closeAt: DateTime }` (`closeAt = slotStartsAt`)
  - `GET /schedule/next`: `bookingOpenAt` = відкриття тренера; `bookingCloseAt` = початок **останнього** групового дня; `bookingWindowOpen = openAt ≤ now < bookingCloseAt`; кожен слот має `started: boolean`. «Наступний день» — перший, де є групове тренера, яке ще не почалося.
  - `GET /admin/schedule`: те саме для власних слотів тренера (день без групових → `closeAt` = кінець дня 23:59).
  - Помилки: `Booking is not open yet` (замість `Booking opens at 14:00`), `Booking window has closed`, `Training has already started`.

- [ ] **Step 1: Тести**
  - `tryBookGroup`: відкриття тренера 12:00 → о 12:30 бронює; о 11:59 → `WINDOW`; слот 10:00 о 10:00 → `WINDOW`.
  - `book`: слот 19:00, відкриття `14:00`, тренер змінив на `16:00` після створення → о 15:00 `Booking is not open yet` (Review Focus 2).
  - `cancel` групового о 19:00:00 для слота 19:00 → `Training has already started`; о 18:59 → ок.
  - `switchSlot` 19:00 → 20:00 о 19:10 → `Training has already started` (Review Focus 3); 20:00 → 19:00 о 19:10 → те саме (ціль почалася).
  - `getNext`: день із 10:00 і 19:00, о 12:00 → цей день, `slots[0].started = true`, `slots[1].started = false`, `bookingWindowOpen = true` (Review Focus 5); о 19:00 → наступний день.
  - клієнт без тренера → вікно за налаштуваннями першого тренера (Review Focus 1).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Реалізувати.** `cancel` для групових — `validateBeforeStart` (прибрати `validateBeforeClose`); `switchSlot` — вікно для цілі + `validateBeforeStart` для старого і нового слота. Час відкриття — `loadTrainerSchedule(db, slot.trainerId).bookingOpensAt`.
- [ ] **Step 4:** PASS; `npm test`, lint, tsc зелено.
- [ ] **Step 5: Commit** `feat(booking): booking opens at the trainer's time and closes when the training starts`.

### Task 4: Пуш «Записуйтесь» у час кожного тренера

**Files:**
- Modify: `backend/src/notifications/internal-cron.controller.ts` (`bookingOpen`)
- Test: `notifications/internal-cron.controller.spec.ts`

**Interfaces:**
- Consumes: `loadTrainerSchedule`, `bookingOpensAt`; існуючі `groupTrainerIds(dayId)`, `getDefaultTrainerId`, `enqueueAndProcess('BOOKING_OPEN', key, { localDate, trainerIds, includeUnassigned })`.

- [ ] **Step 1: Тести** — два тренери з груповими сьогодні, відкриття 10:00 і 16:00, перше групове 18:00 і 19:00:
  - о 10:05 → один `enqueueAndProcess` з ключем `booking-open:<date>:<t1>`, `trainerIds: [t1]`, `includeUnassigned` = `t1` перший тренер;
  - о 16:05 → для обох (дубль t1 відсіче `dedupe_key`);
  - о 18:30 → лише t2 (у t1 перше групове почалося);
  - о 09:00 → нічого.
- [ ] **Step 2:** FAIL. **Step 3:** реалізувати (по тренеру; без вікна «2 години»). **Step 4:** PASS, `npm test` зелено.
- [ ] **Step 5: Commit** `feat(push): booking-open push at each trainer's opening time`.

### Task 5: Групове в календарі на будь-який час

**Files:**
- Modify: `backend/src/admin/admin-schedule.service.ts` (`upsertGroupSlot`), тест у `admin/admin-assigned-slots.spec.ts` (там уже `upsertGroupSlot`)
- Modify: `frontend/app/admin/calendar/page.tsx` (групові: поле часу, як у персональних; прибрати `GROUP_TIMES` і «Буде створено слоти 19:00 і 20:00»; помилки)

**Interfaces:**
- Consumes: `groupTimeError` (Task 1)
- Produces: `PUT /admin/training-days/:date/slots/:slotTime` приймає будь-який час за `groupTimeError` з іншими **активними груповими** тренера того дня; 400 з текстом правила.

- [ ] **Step 1: Тести** `upsertGroupSlot`: `'18:00'` → ок (раніше 400); `'05:45'` → 400 `Group trainings are from 06:00 to 21:00`; `'19:30'` при активному 19:00 → 400 `Group trainings must be at least an hour apart`.
- [ ] **Step 2:** FAIL. **Step 3:** реалізувати. **Step 4:** PASS.
- [ ] **Step 5: Фронтенд.** У модалці «Групові» — одне поле часу (крок 15 хв, `min 06:00`, `max 21:00`), як «Персональні»; помилки бекенду → «Групові можна ставити з 06:00 до 21:00», «Між груповими має бути щонайменше година». Час раніше за відкриття запису тренера (`getMySchedule().bookingOpensAt`) — дозволений, але під полем: «Запис відкривається о HH:MM — на це тренування записатися не вийде». `tsc`, lint, build.
- [ ] **Step 6: Commit** `feat(calendar): group training at any time`.

### Task 6: Сторінка «Мій розклад»

**Перед кодом:** 5 варіантів дизайну сторінки в Design-артефакті (як зазвичай у проєкті), користувачка обирає. Без вибору Task 6 не починати.

**Files:**
- Create: `frontend/app/admin/schedule/page.tsx`
- Modify: `frontend/components/admin/AdminMenu.tsx` (пункт «Мій розклад» після «Календар»), `frontend/lib/api.ts` (`TrainerSchedule`, `getMySchedule()`, `saveMySchedule(s)`)

**Interfaces:**
- Consumes: `GET/PUT /admin/my-schedule` (Task 1)

- [ ] **Step 1:** Сторінка за обраним дизайном: дні Пн…Нд, у кожного обраного — список часу з «+ додати час» і прибиранням; «Запис відкривається о»; перемикач «Автоматично додавати на 3 тижні наперед»; «Зберегти». Помилки бекенду українською: «Запис має відкриватися раніше за перше тренування», «Групові можна ставити з 06:00 до 21:00», «Між груповими має бути щонайменше година», «Час — кроком 15 хвилин».
- [ ] **Step 2:** `tsc`, lint, `npm run build` — зелено.
- [ ] **Step 3: Commit** `feat(admin): «Мій розклад» page`.

### Task 7: Тексти клієнта й тренера під нове вікно

**Files:**
- Modify: `frontend/components/SlotCard.tsx`, `frontend/app/page.tsx`, `frontend/app/admin/page.tsx`, `frontend/lib/api.ts` (`SlotView.started`)

- [ ] **Step 1:**
  - `SlotCard`: `slot.started` → «Запис закрито»; до відкриття — «Запис відкриється о HH:MM» (з `bookingOpenAt`, Київ); «Перейти на …» — лише на групове, що не почалося, і лише поки своє не почалося; коментар про «19:00 / 20:00» оновити.
  - `app/page.tsx`: помилка `Booking is not open yet` → «Запис ще не відкрився»; бейдж «До 14:00» → «До HH:MM».
  - `app/admin/page.tsx`: «До 14:00» → «До HH:MM».
- [ ] **Step 2:** `tsc`, lint, build — зелено.
- [ ] **Step 3: Commit** `feat(schedule): member and trainer pages follow the trainer's booking window`.

### Task 8: Документація

- [ ] CLAUDE.md: розділи Trainers — rules (автостворення за розкладом кожного тренера), Training types (групові: будь-який час 06:00–21:00, вікно від часу тренера до початку тренування, скасування й перехід до початку), NotificationsModule (пуш по тренеру, `dedupe_key`), AdminModule (`/admin/my-schedule`, `upsertGroupSlot`).
- [ ] frontend/CLAUDE.md: `/admin/schedule`, меню.
- [ ] TESTING.md: кроки для «Мій розклад», автостворення, вікно, перехід/скасування після початку, пуш у час тренера; оновити кроки з «14:00», «21:00», «19:00 і 20:00».
- [ ] Туду (пам'ять): регулярний розклад — зроблено; cron-job.org тепер обов'язковий для пушу (кожні 5 хв `GET /internal/cron/booking-open`).
- [ ] Commit `docs: trainer schedule`.
