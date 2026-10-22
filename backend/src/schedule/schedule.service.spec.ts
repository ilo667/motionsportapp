import { DateTime } from 'luxon';
import { ScheduleService } from './schedule.service';

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
    for (const m of ['from', 'innerJoin', 'where', 'for', 'orderBy', 'limit', 'inArray']) {
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
// getMemberCoachId(): a visitor / member without a coach → the first coach
const COACH = [{ id: 'coach-1' }];
// withGroupSlots(): ids of the listed days that have group slots
const HAS_GROUP = [{ dayId: 'day-1' }];
const publishedAnnouncement = { text: 'Записуйтесь сьогодні! 💪', publishedAt: new Date() };
const unpublishedAnnouncement = { text: 'Записуйтесь сьогодні! 💪', publishedAt: null };

function makeService(db: any, now: DateTime) {
  const mockClock = { now: () => now };
  const mockPaymentService = { expireStale: jest.fn().mockResolvedValue(undefined) };
  const service = new ScheduleService({ db } as any, mockClock as any, mockPaymentService as any);
  // Default Mon/Wed/Fri group slots are tested separately
  jest.spyOn(service, 'ensureDefaultGroupSlots').mockResolvedValue(undefined);
  return service;
}

describe('ScheduleService — announcement visibility', () => {
  it('shows announcement when window is open and ann is published', async () => {
    const { db } = makeDb([COACH, [trainingDay], HAS_GROUP, slots, [publishedAnnouncement]]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.announcement).toBe(publishedAnnouncement.text);
  });

  it('hides announcement before 14:00 even if published', async () => {
    const { db } = makeDb([COACH, [trainingDay], HAS_GROUP, slots, [publishedAnnouncement]]);
    const result = await makeService(db, kyivAt(10)).getNext();
    expect(result?.announcement).toBeNull();
  });

  it('hides announcement after 21:00', async () => {
    // After 21:00 today's day is over and nothing later is in the calendar: no group day at all
    const { db } = makeDb([COACH, [trainingDay], HAS_GROUP]);
    const result = await makeService(db, kyivAt(22)).getNext();
    expect(result?.announcement).toBeNull();
  });

  it('hides announcement when publishedAt is null (draft)', async () => {
    const { db } = makeDb([COACH, [trainingDay], HAS_GROUP, slots, [unpublishedAnnouncement]]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.announcement).toBeNull();
  });

  it('hides announcement when no announcement exists', async () => {
    const { db } = makeDb([COACH, [trainingDay], HAS_GROUP, slots, []]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.announcement).toBeNull();
  });
});

describe('ScheduleService — booking window flag', () => {
  it('bookingWindowOpen is false before 14:00', async () => {
    const { db } = makeDb([COACH, [trainingDay], HAS_GROUP, slots, []]);
    const result = await makeService(db, kyivAt(13)).getNext();
    expect(result?.bookingWindowOpen).toBe(false);
  });

  it('bookingWindowOpen is true between 14:00 and 21:00', async () => {
    const { db } = makeDb([COACH, [trainingDay], HAS_GROUP, slots, []]);
    const result = await makeService(db, kyivAt(17)).getNext();
    expect(result?.bookingWindowOpen).toBe(true);
  });

  it('bookingWindowOpen is false after 21:00', async () => {
    const { db } = makeDb([COACH, [trainingDay], HAS_GROUP]);
    const result = await makeService(db, kyivAt(21)).getNext();
    expect(result?.bookingWindowOpen).toBe(false);
  });
});
describe('ScheduleService — assigned trainings', () => {
  it('skips a day that has only assigned trainings when picking the next group day', async () => {
    const assignedOnly = { id: 'day-p', localDate: TODAY, status: 'SCHEDULED' };
    const groupDay = { id: 'day-2', localDate: '2026-10-21', status: 'SCHEDULED' };
    const { db } = makeDb([COACH, [assignedOnly, groupDay], [{ dayId: 'day-2' }], slots, []]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.localDate).toBe('2026-10-21');
  });

  it("lists the member's assigned assigned trainings until they end, with booking state", async () => {
    const assigned = [
      { id: 'p-morning', localDate: TODAY, slotTime: '12:00', trainingType: 'персональні', capacity: 1, bookedCount: 0 },
      { id: 'p-evening', localDate: TODAY, slotTime: '18:00', trainingType: 'спліт', capacity: 2, bookedCount: 1 },
    ];
    const { db } = makeDb([
      assigned,
      [{ slotId: 'p-evening', paymentStatus: 'PAID' }],
      [{ coachId: 'coach-1' }], // the member's coach
      [trainingDay], HAS_GROUP, slots, [], [], [],
    ]);
    const result = await makeService(db, kyivAt(15)).getNext('member-1');

    // 12:00 ended at 13:00, so only the evening split is shown
    expect(result?.assignedSlots).toEqual([
      expect.objectContaining({ id: 'p-evening', isMyBooking: true, myPaymentStatus: 'PAID', started: false }),
    ]);
  });

  it('marks an assigned training as started (no payment) during its hour', async () => {
    const assigned = [{ id: 'p1', localDate: TODAY, slotTime: '15:00', trainingType: 'персональні', capacity: 1, bookedCount: 0 }];
    const { db } = makeDb([assigned, [], [{ coachId: 'coach-1' }], [trainingDay], HAS_GROUP, slots, [], [], []]);
    const result = await makeService(db, kyivAt(15)).getNext('member-1');
    expect(result?.assignedSlots).toEqual([expect.objectContaining({ id: 'p1', isMyBooking: false, started: true })]);
  });
});

describe('ScheduleService — no group day ahead', () => {
  it('returns no group day when there is no group training ahead (e.g. the coach cancelled them)', async () => {
    const { db } = makeDb([[]]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result).toEqual(expect.objectContaining({ localDate: null, slots: [], bookingWindowOpen: false }));
  });

  it("still returns the member's assigned trainings when there is no group day", async () => {
    const assigned = [{ id: 'p1', localDate: TODAY, slotTime: '18:00', trainingType: 'персональні', capacity: 1, bookedCount: 0 }];
    const { db } = makeDb([assigned, [], []]);
    const result = await makeService(db, kyivAt(15)).getNext('member-1');
    expect(result?.localDate).toBeNull();
    expect(result?.assignedSlots).toEqual([expect.objectContaining({ id: 'p1' })]);
  });
});

describe('ScheduleService — default Mon/Wed/Fri group slots', () => {
  // 2026-10-20 is a Tuesday → the next 21 days hold 9 Mon/Wed/Fri dates
  function makeRealService(db: any) {
    const clock = { now: () => kyivAt(10) };
    return new ScheduleService({ db } as any, clock as any, {} as any);
  }

  function recordInserts(db: any) {
    const values: unknown[] = [];
    db.insert = jest.fn(() => {
      const chain: any = { values: (v: unknown) => { values.push(v); return chain; }, onConflictDoNothing: () => Promise.resolve() };
      return chain;
    });
    return values;
  }

  it('adds 19:00 and 20:00 to every scheduled Mon/Wed/Fri, owned by the first coach, never overwriting', async () => {
    const days = [{ id: 'd-wed' }, { id: 'd-fri' }];
    const { db } = makeDb([[{ id: 'coach-1' }], days]);
    const values = recordInserts(db);

    await makeRealService(db).ensureDefaultGroupSlots();

    const dayRows = values[0] as { localDate: string }[];
    expect(dayRows.map((d) => d.localDate)).toEqual([
      '2026-10-21', '2026-10-23', '2026-10-26', '2026-10-28', '2026-10-30', '2026-11-02', '2026-11-04', '2026-11-06', '2026-11-09',
    ]);
    expect(values[1]).toEqual([
      expect.objectContaining({ trainingDayId: 'd-wed', slotTime: '19:00', trainingType: 'групові', coachId: 'coach-1' }),
      expect.objectContaining({ trainingDayId: 'd-wed', slotTime: '20:00', coachId: 'coach-1' }),
      expect.objectContaining({ trainingDayId: 'd-fri', slotTime: '19:00' }),
      expect.objectContaining({ trainingDayId: 'd-fri', slotTime: '20:00' }),
    ]);
  });

  it('runs once per day per instance (the schedule is polled every 5 s)', async () => {
    const { db } = makeDb([[{ id: 'coach-1' }], [{ id: 'd-wed' }]]);
    const values = recordInserts(db);
    const service = makeRealService(db);
    await service.ensureDefaultGroupSlots();
    await service.ensureDefaultGroupSlots();
    expect(values).toHaveLength(2); // days + slots, only from the first call
  });

  it('creates nothing without a coach account', async () => {
    const { db } = makeDb([[]]);
    const values = recordInserts(db);
    await makeRealService(db).ensureDefaultGroupSlots();
    expect(values).toHaveLength(0);
  });
});
