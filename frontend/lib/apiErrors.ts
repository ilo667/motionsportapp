// The backend answers in English (lib/api.ts puts its message into the Error). What a person sees, matched as a
// part of that message; the first match wins, so a longer message goes before a shorter one inside it
const API_ERRORS: [string, string][] = [
  // Booking a group training, cancelling, moving, a guest
  ["Target slot is full", "Місць вже немає, хтось встиг раніше"],
  ["Slot is full", "Місць вже немає, хтось встиг раніше"],
  ["Target slot is cancelled", "Цей час скасовано тренером"],
  ["Slot is cancelled", "Цей час скасовано тренером"],
  ["Slot is no longer available", "Цього тренування вже немає в розкладі"],
  ["Slot not found", "Цього тренування вже немає в розкладі"],
  ["Training day is not scheduled", "Цього дня тренувань немає"],
  ["Booking is not open yet", "Запис ще не відкрився"],
  ["Booking window has closed", "Час запису вже минув"],
  ["Training has already started", "Тренування вже почалося"],
  ["You already have an active booking for this day", "Ви вже записані на цей день"],
  ["Already booked on this slot", "Ви вже записані на це тренування"],
  ["Cancelled late", "Ви скасували це тренування пізно, записатися знову не можна"],
  ["Group pass required", "Потрібен абонемент на групові: натисніть «Записатись» ще раз"],
  ["Guest already added", "Гостя вже додано"],
  ["Membership frozen", "Абонемент заморожено"],
  ["Booking has changed", "Запис змінився. Оновіть сторінку й спробуйте ще раз."],
  ["No active booking", "Запису вже немає. Оновіть сторінку."],
  // Purchases and freezes
  [
    "You have an unpaid purchase",
    "У вас уже є покупка, що очікує оплати. Оплатіть або скасуйте її на сторінці «Мій абонемент».",
  ],
  ["Purchase pending", "Спершу завершіть або скасуйте покупку, що очікує оплати."],
  ["Member still has trainings of this type", "Ще є тренування цього типу: нові можна купити, коли вони закінчаться."],
  ["Member already has a club card", "Клубна карта вже є."],
  ["Club card required", "Спершу потрібна клубна карта."],
  ["Nothing to freeze", "Немає чого заморожувати: клубної карти чи тренувань."],
  ["Freeze already requested", "Запит уже надіслано."],
  // The trainer: calendar, «Розклад групових», marks, refunds
  ["Time is already taken", "На цей час уже є тренування"],
  ["Group trainings are from 06:00 to 21:00", "Групові можна ставити з 06:00 до 21:00"],
  ["at least an hour apart", "Між груповими має бути щонайменше година"],
  ["15-minute steps", "Вкажіть час з кроком 15 хвилин"],
  ["Training time is in the past", "Цей час уже минув"],
  ["Booking must open before the first training", "Запис має відкриватися раніше за перше тренування"],
  ["Attendance already marked", "Цій людині вже поставили відмітку, її не можна прибрати"],
  ["Member is frozen", "Абонемент клієнта заморожено на цей день"],
  ["Money already returned", "Гроші вже повернено, списання не скасувати."],
];

export const DEFAULT_ERROR = "Помилка. Спробуйте ще раз.";

// Ukrainian text for an error from lib/api.ts. Never the backend's English: a message not in the table (or a
// network failure) shows `fallback`. `own` comes first: the same error worded for that place
export function errorText(err: unknown, fallback = DEFAULT_ERROR, own: [string, string][] = []): string {
  const raw = err instanceof Error ? err.message : "";
  if (!raw) return fallback;
  return [...own, ...API_ERRORS].find(([needle]) => raw.includes(needle))?.[1] ?? fallback;
}
