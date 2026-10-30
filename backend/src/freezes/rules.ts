import { DateTime } from 'luxon';
import { KY_ZONE } from '../schedule/training-types';

// From the approval day. Dates are YYYY-MM-DD in Kyiv
export const FREEZE_DAYS = 30;

export type FreezeDates = { status: string; startedOn: string | null; endsOn: string | null };

export const plusDays = (date: string, days: number) =>
  DateTime.fromISO(date, { zone: KY_ZONE }).plus({ days }).toISODate()!;

export const daysBetween = (from: string, to: string) =>
  Math.round(DateTime.fromISO(to, { zone: KY_ZONE }).diff(DateTime.fromISO(from, { zone: KY_ZONE }), 'days').days);

// ends_on is the first day back
export const frozenOn = (f: FreezeDates, date: string) =>
  f.status === 'ACTIVE' && f.startedOn! <= date && date < f.endsOn!;

// Blocks a new request: waiting for the trainer, or approved and not over
export const isOpen = (f: FreezeDates, today: string) =>
  f.status === 'REQUESTED' || (f.status === 'ACTIVE' && today < f.endsOn!);
