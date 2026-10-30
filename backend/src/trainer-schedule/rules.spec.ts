import { getTableConfig } from 'drizzle-orm/pg-core';
import { bookingOpensAt, groupTimeError, LEGACY_DEFAULT, scheduleError } from './rules';
import { trainerSchedules, trainerScheduleTimes } from '../database/schema';

describe('Trainer schedule rules', () => {
  it('group trainings are from 06:00 to 21:00', () => {
    expect(groupTimeError('05:45', [])).toBe('Group trainings are from 06:00 to 21:00');
    expect(groupTimeError('21:15', [])).toBe('Group trainings are from 06:00 to 21:00');
    expect(groupTimeError('06:00', [])).toBeNull();
    expect(groupTimeError('21:00', [])).toBeNull();
  });

  it('times go in 15-minute steps', () => {
    expect(groupTimeError('19:10', [])).toBe('Time must be in 15-minute steps');
    expect(groupTimeError('7:00', [])).toBe('Time must be in 15-minute steps');
  });

  it('two group trainings of a day are at least an hour apart', () => {
    expect(groupTimeError('19:30', ['19:00'])).toBe('Group trainings must be at least an hour apart');
    expect(groupTimeError('18:15', ['19:00'])).toBe('Group trainings must be at least an hour apart');
    expect(groupTimeError('20:00', ['19:00'])).toBeNull();
  });

  it('booking must open before the first training of the schedule', () => {
    expect(
      scheduleError({ bookingOpensAt: '19:00', autoCreate: true, times: [{ weekday: 1, slotTime: '19:00' }] }),
    ).toBe('Booking must open before the first training');
    expect(
      scheduleError({ bookingOpensAt: '14:00', autoCreate: true, times: [{ weekday: 1, slotTime: '19:00' }] }),
    ).toBeNull();
  });

  it('rejects an unknown weekday, a bad time and the same time twice on a day', () => {
    expect(
      scheduleError({ bookingOpensAt: '14:00', autoCreate: true, times: [{ weekday: 8, slotTime: '19:00' }] }),
    ).toBe('Unknown weekday');
    expect(scheduleError({ bookingOpensAt: '14:05', autoCreate: true, times: [] })).toBe(
      'Time must be in 15-minute steps',
    );
    expect(
      scheduleError({
        bookingOpensAt: '14:00',
        autoCreate: true,
        times: [
          { weekday: 1, slotTime: '19:00' },
          { weekday: 1, slotTime: '19:00' },
        ],
      }),
    ).toBe('Group trainings must be at least an hour apart');
  });

  it('the same time on different days is fine; the current schedule is valid', () => {
    expect(
      scheduleError({
        bookingOpensAt: '14:00',
        autoCreate: true,
        times: [
          { weekday: 1, slotTime: '19:00' },
          { weekday: 3, slotTime: '19:00' },
        ],
      }),
    ).toBeNull();
    expect(scheduleError(LEGACY_DEFAULT)).toBeNull();
    expect(LEGACY_DEFAULT.times.map((t) => `${t.weekday} ${t.slotTime}`)).toEqual([
      '1 19:00',
      '1 20:00',
      '3 19:00',
      '3 20:00',
      '5 19:00',
      '5 20:00',
    ]);
  });

  it('booking opens on the training day at the trainer time, in Kyiv', () => {
    expect(bookingOpensAt('2026-10-26', '14:00').toISO()).toBe('2026-10-26T14:00:00.000+02:00');
  });
});

describe('Trainer schedule tables', () => {
  // The DB rejects off-grid times whatever writes them
  it('both time columns carry a format CHECK', () => {
    const checks = (table: Parameters<typeof getTableConfig>[0]) => getTableConfig(table).checks.map((c) => c.name);
    expect(checks(trainerScheduleTimes)).toContain('trainer_schedule_times_slot_time_check');
    expect(checks(trainerSchedules)).toContain('trainer_schedules_booking_opens_at_check');
  });
});
