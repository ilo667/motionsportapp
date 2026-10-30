import { ApiError } from "./api";

// What a person sees for an error the backend answers with a code (backend/src/common/api-error.ts lists them; the
// English message there may be reworded, the code never changes). A code missing here shows the fallback
export const ERROR_TEXT: Record<string, string> = {
  // Booking a group training, cancelling, moving, a guest
  SLOT_FULL: "Місць вже немає, хтось встиг раніше",
  SLOT_CANCELLED: "Цей час скасовано тренером",
  SLOT_NOT_FOUND: "Цього тренування вже немає в розкладі",
  DAY_NOT_SCHEDULED: "Цього дня тренувань немає",
  BOOKING_NOT_OPEN: "Запис ще не відкрився",
  BOOKING_CLOSED: "Час запису вже минув",
  TRAINING_STARTED: "Тренування вже почалося",
  ALREADY_BOOKED_TODAY: "Ви вже записані на цей день",
  ALREADY_ON_SLOT: "Ви вже записані на це тренування",
  CANCELLED_LATE: "Ви скасували це тренування пізно, записатися знову не можна",
  GROUP_PASS_REQUIRED: "Потрібен абонемент на групові: натисніть «Записатись» ще раз",
  GUEST_EXISTS: "Гостя вже додано",
  MEMBERSHIP_FROZEN: "Абонемент заморожено",
  BOOKING_CHANGED: "Запис змінився. Оновіть сторінку й спробуйте ще раз.",
  NO_ACTIVE_BOOKING: "Запису вже немає. Оновіть сторінку.",
  // Purchases and freezes
  UNPAID_PURCHASE: "У вас уже є покупка, що очікує оплати. Оплатіть або скасуйте її на сторінці «Мій абонемент».",
  PURCHASE_PENDING: "Спершу завершіть або скасуйте покупку, що очікує оплати.",
  TRAININGS_LEFT: "Ще є тренування цього типу: нові можна купити, коли вони закінчаться.",
  CLUB_CARD_EXISTS: "Клубна карта вже є.",
  CLUB_CARD_REQUIRED: "Спершу потрібна клубна карта.",
  NOTHING_TO_FREEZE: "Немає чого заморожувати: клубної карти чи тренувань.",
  FREEZE_REQUESTED: "Запит уже надіслано.",
  // The trainer: calendar, «Розклад групових», marks, refunds
  TIME_TAKEN: "На цей час уже є тренування",
  GROUP_HOURS: "Групові можна ставити з 06:00 до 21:00",
  GROUP_GAP: "Між груповими має бути щонайменше година",
  TIME_GRID: "Вкажіть час з кроком 15 хвилин",
  TIME_PAST: "Цей час уже минув",
  OPENS_AFTER_TRAINING: "Запис має відкриватися раніше за перше тренування",
  ATTENDANCE_MARKED: "Цій людині вже поставили відмітку, її не можна прибрати",
  MEMBER_FROZEN: "Абонемент клієнта заморожено на цей день",
  MONEY_RETURNED: "Гроші вже повернено, списання не скасувати.",
};

export const DEFAULT_ERROR = "Помилка. Спробуйте ще раз.";

// Ukrainian text for an error from lib/api.ts, by the code in the body. Never the backend's English: no code, a code
// not in the table or a network failure shows `fallback`. `own` comes first: the same error worded for that place
export function errorText(err: unknown, fallback = DEFAULT_ERROR, own: Record<string, string> = {}): string {
  const code = err instanceof ApiError ? err.body.code : undefined;
  if (typeof code !== "string") return fallback;
  if (has(own, code)) return own[code];
  return has(ERROR_TEXT, code) ? ERROR_TEXT[code] : fallback;
}

// Own keys only (not «constructor» and the like); Object.hasOwn is missing on iOS before 15.4
const has = (table: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(table, key);
