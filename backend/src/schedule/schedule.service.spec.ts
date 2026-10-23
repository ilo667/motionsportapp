import { DateTime } from 'luxon';
import { ScheduleService } from './schedule.service';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';

jest.mock('../trainer-schedule/trainer-schedule.store', () => ({ loadTrainerSchedule: jest.fn() }));
const mockLoadSchedule = loadTrainerSchedule as jest.Mock;

const KY_ZONE = 'Europe/Kyiv';

function kyivAt(hour: number): DateTime {
  return DateTime.fromObject({ year: 2026, month: 10, day: 20, hour }, { zone: KY_ZONE });
}

function makeDb(results: unknown[][] = []) {
  let idx = 0;
  const next = () => results[idx++] ?? [];

  function readLink(): any {
    const then = (resolve: (v: unknown) => void) => resolve(next());
    const chain: any = { then };
    for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'for', 'orderBy', 'limit', 'inArray', 'groupBy']) {
      chain[m] = jest.fn().mockImplementation(() => readLink());
    }
    return chain;
  }

  function writeLink(): any {
    const then = (resolve: (v: void) => void) => resolve();
    const chain: any = { then };
    for (const m of ['set', 'where', 'values', 'onConflictDoNothing']) {
      chain[m] = jest.fn().mockImplementation(() => writeLink());
    }
    return chain;
  }

  const db: any = {
    select: jest.fn().mockImplementation(() => readLink()),
    selectDistinct: jest.fn().mockImplementation(() => readLink()),
    insert: jest.fn().mockImplementation(() => writeLink()),
    update: jest.fn().mockImplementation(() => writeLink()),
    transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<unknown>) => cb(db)),
  };
  return { db };
}

const TODAY = '2026-10-20';

const trainingDay = { id: 'day-1', localDate: TODAY, status: 'SCHEDULED' };
const slots = [
  { id: 'slot-1', slotTime: '19:00', status: 'ACTIVE', capacity: 8, bookedCount: 5 },
  { id: 'slot-2', slotTime: '20:00', status: 'ACTIVE', capacity: 8, bookedCount: 3 },
];
// getMemberTrainerId(): a visitor / member without a trainer → the first trainer
const TRAINER = [{ id: 'trainer-1' }];
// withGroupSlots(): the listed days that have group slots of the trainer, with the last one's time
const HAS_GROUP = [{ dayId: 'day-1', lastTime: '20:00' }];
const publishedAnnouncement = { text: 'Записуйтесь сьогодні! 💪', publishedAt: new Date() };
const unpublishedAnnouncement = { text: 'Записуйтесь сьогодні! 💪', publishedAt: null };

function makeService(db: any, now: DateTime, packages: unknown[] = [], groupPassLeft = 0) {
  const mockClock = { now: () => now };
  const mockPaymentService = { expireStale: jest.fn().mockResolvedValue(undefined) };
  const mockEntitlements = {
    packagesOf: jest.fn().mockResolvedValue(packages),
    groupPassLeft: jest.fn().mockResolvedValue(groupPassLeft),
  };
  const service = new ScheduleService({ db } as any, mockClock, mockPaymentService as any, mockEntitlements as any);
  mockLoadSchedule.mockResolvedValue({ bookingOpensAt: '14:00', autoCreate: true, times: [] });
  // Group trainings created from the trainer schedules are tested separately
  jest.spyOn(service, 'ensureGroupSlots').mockResolvedValue(undefined);
  return service;
}

describe('ScheduleService — group pass', () => {
  it('tells the member how many group trainings their pass has for that day', async () => {
    // No assigned trainings, then the usual group-day reads (the member's booking, alerts, announcement)
    const { db } = makeDb([[], [{ trainerId: 'trainer-1' }], [trainingDay], HAS_GROUP, slots, [], [], []]);
    const result = await makeService(db, kyivAt(15), [], 7).getNext('member-1');
    expect(result.groupPassLeft).toBe(7);
  });

  it('a visitor has none', async () => {
    const { db } = makeDb([TRAINER, [trainingDay], HAS_GROUP, slots, [publishedAnnouncement]]);
    const result = await makeService(db, kyivAt(15), [], 7).getNext();
    expect(result.groupPassLeft).toBe(0);
  });
});

describe('ScheduleService — announcement visibility', () => {
  it('shows announcement when window is open and ann is published', async () => {
    const { db } = makeDb([TRAINER, [trainingDay], HAS_GROUP, slots, [publishedAnnouncement]]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.announcement).toBe(publishedAnnouncement.text);
  });

  it('hides announcement before 14:00 even if published', async () => {
    const { db } = makeDb([TRAINER, [trainingDay], HAS_GROUP, slots, [publishedAnnouncement]]);
    const result = await makeService(db, kyivAt(10)).getNext();
    expect(result?.announcement).toBeNull();
  });

  it('hides announcement once the last group training started', async () => {
    // After 20:00 today's group trainings have all started and nothing later is in the calendar: no group day
    const { db } = makeDb([TRAINER, [trainingDay], HAS_GROUP]);
    const result = await makeService(db, kyivAt(20)).getNext();
    expect(result?.announcement).toBeNull();
  });

  it('hides announcement when publishedAt is null (draft)', async () => {
    const { db } = makeDb([TRAINER, [trainingDay], HAS_GROUP, slots, [unpublishedAnnouncement]]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.announcement).toBeNull();
  });

  it('hides announcement when no announcement exists', async () => {
    const { db } = makeDb([TRAINER, [trainingDay], HAS_GROUP, slots, []]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.announcement).toBeNull();
  });
});

describe('ScheduleService — booking window flag', () => {
  it('bookingWindowOpen is false before 14:00', async () => {
    const { db } = makeDb([TRAINER, [trainingDay], HAS_GROUP, slots, []]);
    const result = await makeService(db, kyivAt(13)).getNext();
    expect(result?.bookingWindowOpen).toBe(false);
  });

  it('bookingWindowOpen is true from 14:00 until the last group training starts', async () => {
    const { db } = makeDb([TRAINER, [trainingDay], HAS_GROUP, slots, []]);
    const result = await makeService(db, kyivAt(19)).getNext();
    expect(result?.bookingWindowOpen).toBe(true);
    expect(result?.bookingCloseAt).toBe('2026-10-20T17:00:00.000Z'); // 20:00 Kyiv (UTC+3 until 25 Oct)
    expect(result?.slots.map((s) => s.started)).toEqual([true, false]);
  });

  it('opens at the time of the trainer whose trainings the member sees (a visitor: the first trainer)', async () => {
    const { db } = makeDb([TRAINER, [trainingDay], HAS_GROUP, slots, []]);
    const service = makeService(db, kyivAt(15));
    mockLoadSchedule.mockResolvedValue({ bookingOpensAt: '16:00', autoCreate: true, times: [] });
    const result = await service.getNext();
    expect(mockLoadSchedule).toHaveBeenCalledWith(db, 'trainer-1');
    expect(result?.bookingWindowOpen).toBe(false);
    expect(result?.bookingOpenAt).toBe('2026-10-20T13:00:00.000Z'); // 16:00 Kyiv
  });

  it('a day with 10:00 and 19:00: at 12:00 still this day, 10:00 started, 19:00 open', async () => {
    const day = [
      { id: 's-am', slotTime: '10:00', status: 'ACTIVE', capacity: 8, bookedCount: 2 },
      { id: 's-pm', slotTime: '19:00', status: 'ACTIVE', capacity: 8, bookedCount: 1 },
    ];
    const { db } = makeDb([TRAINER, [trainingDay], [{ dayId: 'day-1', lastTime: '19:00' }], day, []]);
    const service = makeService(db, kyivAt(12));
    mockLoadSchedule.mockResolvedValue({ bookingOpensAt: '08:00', autoCreate: true, times: [] });
    const result = await service.getNext();
    expect(result?.localDate).toBe(TODAY);
    expect(result?.bookingWindowOpen).toBe(true);
    expect(result?.slots.map((s) => [s.slotTime, s.started])).toEqual([
      ['10:00', true],
      ['19:00', false],
    ]);
  });

  it('bookingWindowOpen is false once the last group training started', async () => {
    const { db } = makeDb([TRAINER, [trainingDay], HAS_GROUP]);
    const result = await makeService(db, kyivAt(20)).getNext();
    expect(result?.bookingWindowOpen).toBe(false);
  });
});
describe('ScheduleService — assigned trainings', () => {
  it('skips a day that has only assigned trainings when picking the next group day', async () => {
    const assignedOnly = { id: 'day-p', localDate: TODAY, status: 'SCHEDULED' };
    const groupDay = { id: 'day-2', localDate: '2026-10-21', status: 'SCHEDULED' };
    const { db } = makeDb([TRAINER, [assignedOnly, groupDay], [{ dayId: 'day-2', lastTime: '20:00' }], slots, []]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.localDate).toBe('2026-10-21');
  });

  it("lists the member's assigned trainings until they end, with booking state and trainings left", async () => {
    const assigned = [
      {
        id: 'p-morning',
        localDate: TODAY,
        slotTime: '12:00',
        trainingType: 'персональні',
        capacity: 1,
        bookedCount: 0,
      },
      { id: 'p-evening', localDate: TODAY, slotTime: '18:00', trainingType: 'спліт', capacity: 2, bookedCount: 1 },
    ];
    const { db } = makeDb([
      assigned,
      [{ slotId: 'p-evening', spentFrom: 'pkg-1' }],
      [{ trainerId: 'trainer-1' }], // the member's trainer
      [trainingDay],
      HAS_GROUP,
      slots,
      [],
      [],
      [],
    ]);
    const packages = [
      { trainingType: 'спліт', left: 3 },
      { trainingType: 'спліт', left: 2 },
      { trainingType: 'персональні', left: 4 },
    ];
    const result = await makeService(db, kyivAt(15), packages).getNext('member-1');

    // 12:00 ended at 13:00, so only the evening split is shown; its trainings left = all split packages
    expect(result?.assignedSlots).toEqual([
      expect.objectContaining({ id: 'p-evening', isMyBooking: true, spent: true, packageLeft: 5, started: false }),
    ]);
    expect(result?.assignedSlots?.[0]).not.toHaveProperty('myPaymentStatus');
  });

  it('marks an assigned training as started (no payment) during its hour', async () => {
    const assigned = [
      { id: 'p1', localDate: TODAY, slotTime: '15:00', trainingType: 'персональні', capacity: 1, bookedCount: 0 },
    ];
    const { db } = makeDb([assigned, [], [{ trainerId: 'trainer-1' }], [trainingDay], HAS_GROUP, slots, [], [], []]);
    const result = await makeService(db, kyivAt(15)).getNext('member-1');
    expect(result?.assignedSlots).toEqual([expect.objectContaining({ id: 'p1', isMyBooking: false, started: true })]);
  });
});

describe('ScheduleService — payment expiry never breaks the schedule', () => {
  it('still answers when expiring stale payments fails (e.g. a DB deadlock)', async () => {
    const { db } = makeDb([[]]);
    const service = makeService(db, kyivAt(15));
    (service as any).paymentService.expireStale.mockRejectedValue(new Error('deadlock detected'));
    await expect(service.getNext()).resolves.toEqual(expect.objectContaining({ localDate: null }));
  });
});

describe('ScheduleService — no group day ahead', () => {
  it('returns no group day when there is no group training ahead (e.g. the trainer cancelled them)', async () => {
    const { db } = makeDb([[]]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result).toEqual(expect.objectContaining({ localDate: null, slots: [], bookingWindowOpen: false }));
  });

  it("still returns the member's assigned trainings when there is no group day", async () => {
    const assigned = [
      { id: 'p1', localDate: TODAY, slotTime: '18:00', trainingType: 'персональні', capacity: 1, bookedCount: 0 },
    ];
    const { db } = makeDb([assigned, [], []]);
    const result = await makeService(db, kyivAt(15)).getNext('member-1');
    expect(result?.localDate).toBeNull();
    expect(result?.assignedSlots).toEqual([expect.objectContaining({ id: 'p1' })]);
  });
});

describe('ScheduleService — group trainings from each trainer schedule', () => {
  // 2026-10-20 is a Tuesday; the horizon is 21 days: 2026-10-20 … 2026-11-09
  function makeRealService(db: any) {
    const clock = { now: () => kyivAt(10) };
    return new ScheduleService({ db } as any, clock, {} as any, {} as any);
  }

  function recordInserts(db: any) {
    const values: unknown[] = [];
    db.insert = jest.fn(() => {
      const chain: any = {
        values: (v: unknown) => {
          values.push(v);
          return chain;
        },
        onConflictDoNothing: () => Promise.resolve(),
      };
      return chain;
    });
    return values;
  }

  const MON_10_WED_19 = {
    bookingOpensAt: '08:00',
    autoCreate: true,
    times: [
      { weekday: 1, slotTime: '10:00' },
      { weekday: 3, slotTime: '19:00' },
    ],
  };

  beforeEach(() => mockLoadSchedule.mockReset());

  it("creates each trainer's own times on their weekdays only, 8 seats, never overwriting", async () => {
    mockLoadSchedule.mockResolvedValue(MON_10_WED_19);
    // reads: trainers, the scheduled days, this trainer's group slots on them
    const days = [
      { id: 'd-wed', localDate: '2026-10-21' },
      { id: 'd-mon', localDate: '2026-10-26' },
    ];
    const { db } = makeDb([[{ id: 'trainer-2' }], days, []]);
    const values = recordInserts(db);

    await makeRealService(db).ensureGroupSlots();

    expect((values[0] as { localDate: string }[]).map((d) => d.localDate)).toEqual([
      '2026-10-21',
      '2026-10-26',
      '2026-10-28',
      '2026-11-02',
      '2026-11-04',
      '2026-11-09',
    ]);
    expect(values[1]).toEqual([
      expect.objectContaining({
        trainingDayId: 'd-wed',
        slotTime: '19:00',
        trainingType: 'групові',
        capacity: 8,
        trainerId: 'trainer-2',
      }),
      expect.objectContaining({ trainingDayId: 'd-mon', slotTime: '10:00', trainerId: 'trainer-2' }),
    ]);
  });

  it('a trainer with automatic creation off gets nothing', async () => {
    mockLoadSchedule.mockResolvedValue({ ...MON_10_WED_19, autoCreate: false });
    const { db } = makeDb([[{ id: 'trainer-2' }]]);
    const values = recordInserts(db);
    await makeRealService(db).ensureGroupSlots();
    expect(values).toHaveLength(0);
  });

  it('skips a day the trainer cancelled (a cancelled group, none active), even for a new time', async () => {
    mockLoadSchedule.mockResolvedValue(MON_10_WED_19);
    const days = [
      { id: 'd-wed', localDate: '2026-10-21' },
      { id: 'd-mon', localDate: '2026-10-26' },
    ];
    const { db } = makeDb([[{ id: 'trainer-2' }], days, [{ trainingDayId: 'd-wed', status: 'CANCELLED' }]]);
    const values = recordInserts(db);
    await makeRealService(db).ensureGroupSlots();
    expect((values[1] as { trainingDayId: string }[]).map((v) => v.trainingDayId)).toEqual(['d-mon']);
  });

  it('a day with one cancelled and one active group is not skipped (the cancelled time stays cancelled)', async () => {
    mockLoadSchedule.mockResolvedValue(MON_10_WED_19);
    const days = [{ id: 'd-wed', localDate: '2026-10-21' }];
    const { db } = makeDb([
      [{ id: 'trainer-2' }],
      days,
      [
        { trainingDayId: 'd-wed', status: 'CANCELLED' },
        { trainingDayId: 'd-wed', status: 'ACTIVE' },
      ],
    ]);
    const values = recordInserts(db);
    await makeRealService(db).ensureGroupSlots();
    expect((values[1] as { trainingDayId: string }[]).map((v) => v.trainingDayId)).toEqual(['d-wed']);
  });

  it('runs once per day per instance, but force (a saved schedule) runs again for that trainer', async () => {
    mockLoadSchedule.mockResolvedValue(MON_10_WED_19);
    const day = [{ id: 'd-wed', localDate: '2026-10-21' }];
    const { db } = makeDb([[{ id: 'trainer-2' }], day, [], day, []]);
    const values = recordInserts(db);
    const service = makeRealService(db);
    await service.ensureGroupSlots();
    await service.ensureGroupSlots();
    expect(values).toHaveLength(2); // days + slots, only from the first call
    await service.ensureGroupSlots('trainer-2', { force: true });
    expect(values).toHaveLength(4);
  });

  it('creates nothing without a trainer account', async () => {
    const { db } = makeDb([[]]);
    const values = recordInserts(db);
    await makeRealService(db).ensureGroupSlots();
    expect(values).toHaveLength(0);
  });
});
