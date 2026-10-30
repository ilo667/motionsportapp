import { DateTime } from 'luxon';
import { KY_ZONE } from '../schedule/training-types';

// Club card and package dates: Kyiv YYYY-MM-DD, compared as strings. A month ends on the same date
// (or the month's last day), inclusive

const plusMonths = (date: string, months: number) =>
  DateTime.fromISO(date, { zone: KY_ZONE }).plus({ months }).toISODate()!;

// Not activated by then: it burns
export const activateByFor = (purchasedOn: string) => plusMonths(purchasedOn, 1);

// From the activation day; 0 months = that day only
export const validUntilFor = (activatedOn: string, months: number) => plusMonths(activatedOn, months);

export type PassDates = {
  purchasedOn: string;
  activateBy: string;
  activatedOn: string | null;
  validUntil: string | null;
};

// From the purchase day until activate_by (waiting) or valid_until (activated)
export const passUsableOn = (p: PassDates, date: string) =>
  p.purchasedOn <= date && date <= (p.activatedOn ? p.validUntil! : p.activateBy);

export type CardState = 'waiting' | 'active' | 'expired' | 'burned';

export function cardState(
  c: { activateBy: string; validFrom: string | null; validUntil: string | null },
  today: string,
): CardState {
  if (!c.validFrom) return today <= c.activateBy ? 'waiting' : 'burned';
  return today <= c.validUntil! ? 'active' : 'expired';
}

export type PassState = 'waiting' | 'active' | 'expired' | 'burned' | 'used';

export function passState(p: PassDates & { left: number }, today: string): PassState {
  if (p.left <= 0) return 'used';
  if (!p.activatedOn) return today <= p.activateBy ? 'waiting' : 'burned';
  return today <= p.validUntil! ? 'active' : 'expired';
}
