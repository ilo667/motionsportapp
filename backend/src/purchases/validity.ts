import { DateTime } from 'luxon';
import { KY_ZONE } from '../schedule/training-types';

// Date rules for club cards and packages (trainer services and group passes). All dates are YYYY-MM-DD in Kyiv,
// so they compare as strings. A month runs to the same date (or the month's last day), that day included

const plusMonths = (date: string, months: number) =>
  DateTime.fromISO(date, { zone: KY_ZONE }).plus({ months }).toISODate()!;

// Not activated within a month of the purchase: it burns
export const activateByFor = (purchasedOn: string) => plusMonths(purchasedOn, 1);

// From the activation day; 0 months = that day only
export const validUntilFor = (activatedOn: string, months: number) => plusMonths(activatedOn, months);

export type PassDates = {
  purchasedOn: string;
  activateBy: string;
  activatedOn: string | null;
  validUntil: string | null;
};

// Can the pass pay for a training on this date? Never for one before the purchase; a waiting pass until its
// last day to activate (the first mark activates it), an activated one until its last day
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
