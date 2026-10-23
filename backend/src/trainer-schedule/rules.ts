import { DateTime } from 'luxon';
import { KY_ZONE } from '../schedule/training-types';

// A trainer's regular group trainings («Мій розклад»): times per weekday (Luxon: 1 = Mon … 7 = Sun), one opening
// time for booking on the training day, and whether they are created ahead by themselves
export type TrainerSchedule = {
  bookingOpensAt: string; // 'HH:MM'
  autoCreate: boolean;
  times: { weekday: number; slotTime: string }[];
};

export const GROUP_EARLIEST = '06:00';
// The 22:00 cron marks the whole day, so a group training has to be over by then
export const GROUP_LATEST = '21:00';
// A group training lasts an hour: two of one trainer on a day can't overlap
export const GROUP_MIN_GAP_MINUTES = 60;
export const DEFAULT_OPENS_AT = '14:00';

// What the first trainer had before schedules existed: Mon/Wed/Fri 19:00 and 20:00, booking from 14:00
export const LEGACY_DEFAULT: TrainerSchedule = {
  bookingOpensAt: DEFAULT_OPENS_AT,
  autoCreate: true,
  times: [1, 3, 5].flatMap((weekday) => ['19:00', '20:00'].map((slotTime) => ({ weekday, slotTime }))),
};

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const onGrid = (time: string) => /^\d{2}:\d{2}$/.test(time) && minutes(time) % 15 === 0 && minutes(time) < 24 * 60;

// One group training time against the others of that day (the schedule page and the calendar)
export function groupTimeError(slotTime: string, sameDayTimes: string[]): string | null {
  if (!onGrid(slotTime)) return 'Time must be in 15-minute steps';
  if (slotTime < GROUP_EARLIEST || slotTime > GROUP_LATEST) return 'Group trainings are from 06:00 to 21:00';
  if (sameDayTimes.some((t) => Math.abs(minutes(t) - minutes(slotTime)) < GROUP_MIN_GAP_MINUTES))
    return 'Group trainings must be at least an hour apart';
  return null;
}

export function scheduleError(s: TrainerSchedule): string | null {
  if (!onGrid(s.bookingOpensAt)) return 'Time must be in 15-minute steps';
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
  if (s.times.some((t) => t.slotTime <= s.bookingOpensAt)) return 'Booking must open before the first training';
  return null;
}

// Booking for a group training opens on its day at the trainer's time (Kyiv)
export function bookingOpensAt(localDate: string, opensAt: string): DateTime {
  return DateTime.fromISO(`${localDate}T${opensAt}:00`, { zone: KY_ZONE });
}
