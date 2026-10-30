// Errors a person can run into, by a stable code: the frontend shows its own Ukrainian text for the code
// (frontend/lib/apiErrors.ts), so the English message may be reworded freely; the code never changes.
// Thrown as `new ConflictException(apiError('SLOT_FULL'))`: the body is { code, message }, and the exception's
// message stays the English text (logs, tests)
export const API_ERRORS = {
  // Booking a group training, cancelling, moving, a guest
  SLOT_FULL: 'Slot is full',
  SLOT_CANCELLED: 'Slot is cancelled',
  SLOT_NOT_FOUND: 'Slot not found',
  DAY_NOT_SCHEDULED: 'Training day is not scheduled',
  BOOKING_NOT_OPEN: 'Booking is not open yet',
  BOOKING_CLOSED: 'Booking window has closed',
  TRAINING_STARTED: 'Training has already started',
  ALREADY_BOOKED_TODAY: 'You already have an active booking for this day',
  ALREADY_ON_SLOT: 'Already booked on this slot',
  CANCELLED_LATE: 'Cancelled late',
  GROUP_PASS_REQUIRED: 'Group pass required',
  GUEST_EXISTS: 'Guest already added',
  MEMBERSHIP_FROZEN: 'Membership frozen',
  BOOKING_CHANGED: 'Booking has changed, refresh and try again',
  NO_ACTIVE_BOOKING: 'No active booking found',
  // Purchases and freezes
  UNPAID_PURCHASE: 'You have an unpaid purchase',
  PURCHASE_PENDING: 'Purchase pending',
  TRAININGS_LEFT: 'Member still has trainings of this type',
  CLUB_CARD_EXISTS: 'Member already has a club card',
  CLUB_CARD_REQUIRED: 'Club card required',
  NOTHING_TO_FREEZE: 'Nothing to freeze',
  FREEZE_REQUESTED: 'Freeze already requested',
  // The trainer: calendar, «Розклад групових», marks, refunds
  TIME_TAKEN: 'Time is already taken',
  GROUP_HOURS: 'Group trainings are from 06:00 to 21:00',
  GROUP_GAP: 'Group trainings must be at least an hour apart',
  TIME_GRID: 'Time must be in 15-minute steps',
  TIME_PAST: 'Training time is in the past',
  OPENS_AFTER_TRAINING: 'Booking must open before the first training',
  ATTENDANCE_MARKED: 'Attendance already marked',
  MEMBER_FROZEN: 'Member is frozen',
  MONEY_RETURNED: 'Money already returned',
} as const;

export type ApiErrorCode = keyof typeof API_ERRORS;

// The body of an error with a code; `message` words this place's case of it (e.g. «Target slot is full»)
export const apiError = (code: ApiErrorCode, message: string = API_ERRORS[code]) => ({ code, message });

// The schedule rules (trainer-schedule/rules.ts) answer with a message from the list above, or another one
// (e.g. «Unknown weekday»): the code is found by that exact message, none for one not in the list
export function ruleError(message: string) {
  const code = (Object.keys(API_ERRORS) as ApiErrorCode[]).find((c) => API_ERRORS[c] === message);
  return code ? apiError(code, message) : { message };
}
