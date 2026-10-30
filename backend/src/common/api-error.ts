// User-facing errors by stable code; the frontend maps the code to its own text (frontend/lib/apiErrors.ts).
// Messages may be reworded, codes never change. Body: { code, message }
export const API_ERRORS = {
  // Booking, cancelling, moving, guests
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
  // Trainer: calendar, weekly schedule, marks, refunds
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

// `message` can word the error for one place
export const apiError = (code: ApiErrorCode, message: string = API_ERRORS[code]) => ({ code, message });

// Schedule rules return messages; find the code by exact message (none if not listed)
export function ruleError(message: string) {
  const code = (Object.keys(API_ERRORS) as ApiErrorCode[]).find((c) => API_ERRORS[c] === message);
  return code ? apiError(code, message) : { message };
}
