import { DateTime } from 'luxon';
import { KY_ZONE } from '../schedule/training-types';
import { API_ERRORS } from '../common/api-error';

// weekday as in Luxon: 1 = Mon ... 7 = Sun
export type TrainerSchedule = {
  bookingOpensAt: string; // 'HH:MM'
  autoCreate: boolean;
  times: { weekday: number; slotTime: string }[];
};

export const GROUP_EARLIEST = '06:00';
// The 22:00 cron marks the whole day, so the last group must be over by then
export const GROUP_LATEST = '21:00';
// A group training lasts an hour; one trainer's groups can't overlap
export const GROUP_MIN_GAP_MINUTES = 60;
export const DEFAULT_OPENS_AT = '14:00';

// The first trainer's schedule before schedules were saved, so nothing changed for their clients
export const LEGACY_DEFAULT: TrainerSchedule = {
  bookingOpensAt: DEFAULT_OPENS_AT,
  autoCreate: true,
  times: [1, 3, 5].flatMap((weekday) => ['19:00', '20:00'].map((slotTime) => ({ weekday, slotTime }))),
};

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const onGrid = (time: string) => /^\d{2}:\d{2}$/.test(time) && minutes(time) % 15 === 0 && minutes(time) < 24 * 60;

// Shared by the schedule page and the calendar
export function groupTimeError(slotTime: string, sameDayTimes: string[]): string | null {
  if (!onGrid(slotTime)) return API_ERRORS.TIME_GRID;
  if (slotTime < GROUP_EARLIEST || slotTime > GROUP_LATEST) return API_ERRORS.GROUP_HOURS;
  if (sameDayTimes.some((t) => Math.abs(minutes(t) - minutes(slotTime)) < GROUP_MIN_GAP_MINUTES))
    return API_ERRORS.GROUP_GAP;
  return null;
}

export function scheduleError(s: TrainerSchedule): string | null {
  if (!onGrid(s.bookingOpensAt)) return API_ERRORS.TIME_GRID;
  for (let i = 0; i < s.times.length; i++) {
    const { weekday, slotTime } = s.times[i];
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return 'Unknown weekday';
    const earlier = s.times.slice(0, i).filter((t) => t.weekday === weekday);
    const error = groupTimeError(
      slotTime,
      earlier.map((t) => t.slotTime),
    );
    if (error) return error;
  }
  if (s.times.some((t) => t.slotTime <= s.bookingOpensAt)) return API_ERRORS.OPENS_AFTER_TRAINING;
  return null;
}

// Kyiv time on the training day
export function bookingOpensAt(localDate: string, opensAt: string): DateTime {
  return DateTime.fromISO(`${localDate}T${opensAt}:00`, { zone: KY_ZONE });
}
