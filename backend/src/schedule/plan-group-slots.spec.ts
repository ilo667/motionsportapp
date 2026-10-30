import { planGroupSlots } from './schedule.service';

// One date with 19:00 and 20:00 still ahead; the day exists as d1
const DATE = '2026-11-02';
const plan = (own: { status: string; slotTime: string }[], dayIdOf = new Map([[DATE, 'd1']])) =>
  planGroupSlots(
    [DATE],
    () => ['19:00', '20:00'],
    dayIdOf,
    own.map((o) => ({ ...o, trainingDayId: 'd1' })),
  );

describe('planGroupSlots', () => {
  it('a free day: both times are added', () => {
    expect(plan([])).toEqual({
      toInsert: [
        { trainingDayId: 'd1', slotTime: '19:00', date: DATE },
        { trainingDayId: 'd1', slotTime: '20:00', date: DATE },
      ],
      skipped: [],
    });
  });

  it('a time already there (active) is neither added nor reported', () => {
    expect(plan([{ status: 'ACTIVE', slotTime: '19:00' }])).toEqual({
      toInsert: [{ trainingDayId: 'd1', slotTime: '20:00', date: DATE }],
      skipped: [],
    });
  });

  it('a group training the trainer cancelled is not brought back', () => {
    expect(
      plan([
        { status: 'CANCELLED', slotTime: '19:00' },
        { status: 'ACTIVE', slotTime: '20:00' },
      ]),
    ).toEqual({
      toInsert: [],
      skipped: [{ date: DATE, slotTime: '19:00', reason: 'cancelled' }],
    });
  });

  it('a day the trainer cancelled (a cancelled group, none active): every time is left out', () => {
    expect(plan([{ status: 'CANCELLED', slotTime: '18:00' }]).skipped).toEqual([
      { date: DATE, slotTime: '19:00', reason: 'cancelled' },
      { date: DATE, slotTime: '20:00', reason: 'cancelled' },
    ]);
  });

  it('a CANCELLED day (no SCHEDULED day id): left out as cancelled', () => {
    expect(plan([], new Map()).skipped).toEqual([
      { date: DATE, slotTime: '19:00', reason: 'cancelled' },
      { date: DATE, slotTime: '20:00', reason: 'cancelled' },
    ]);
  });

  it('a time within an hour of an active group that day is taken', () => {
    expect(plan([{ status: 'ACTIVE', slotTime: '19:30' }])).toEqual({
      toInsert: [],
      skipped: [
        { date: DATE, slotTime: '19:00', reason: 'taken' },
        { date: DATE, slotTime: '20:00', reason: 'taken' },
      ],
    });
  });
});
