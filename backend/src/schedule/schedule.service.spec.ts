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

const trainingDay = { id: 'day-1', localDate: TODAY, status: 'SCHEDULED', isException: false };
const slots = [
  { id: 'slot-1', slotTime: '19:00', status: 'ACTIVE', capacity: 8, bookedCount: 5 },
  { id: 'slot-2', slotTime: '20:00', status: 'ACTIVE', capacity: 8, bookedCount: 3 },
];
// withGroupSlots(): ids of the listed days that have group slots
const HAS_GROUP = [{ dayId: 'day-1' }];
const publishedAnnouncement = { text: 'Записуйтесь сьогодні! 💪', publishedAt: new Date() };
const unpublishedAnnouncement = { text: 'Записуйтесь сьогодні! 💪', publishedAt: null };

function makeService(db: any, now: DateTime) {
  const mockDemoService = {
    getNow: jest.fn().mockResolvedValue(now),
    isDemoMode: jest.fn().mockReturnValue(false),
  };
  const mockPaymentService = { expireStale: jest.fn().mockResolvedValue(undefined) };
  const service = new ScheduleService({ db } as any, mockDemoService as any, mockPaymentService as any);
  // Skip materializeUpcoming — it's a maintenance operation, not business logic under test
  jest.spyOn(service as any, 'materializeUpcoming').mockResolvedValue(undefined);
  return service;
}

describe('ScheduleService — announcement visibility', () => {
  it('shows announcement when window is open and ann is published', async () => {
    const { db } = makeDb([[trainingDay], HAS_GROUP, slots, [publishedAnnouncement]]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.announcement).toBe(publishedAnnouncement.text);
  });

  it('hides announcement before 14:00 even if published', async () => {
    const { db } = makeDb([[trainingDay], HAS_GROUP, slots, [publishedAnnouncement]]);
    const result = await makeService(db, kyivAt(10)).getNext();
    expect(result?.announcement).toBeNull();
  });

  it('hides announcement after 21:00', async () => {
    // After 21:00 no listed day qualifies, so getNext() runs the fallback lookup (days + group check) once more
    const { db } = makeDb([[trainingDay], HAS_GROUP, [trainingDay], HAS_GROUP, slots, [publishedAnnouncement]]);
    const result = await makeService(db, kyivAt(22)).getNext();
    expect(result?.announcement).toBeNull();
  });

  it('hides announcement when publishedAt is null (draft)', async () => {
    const { db } = makeDb([[trainingDay], HAS_GROUP, slots, [unpublishedAnnouncement]]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.announcement).toBeNull();
  });

  it('hides announcement when no announcement exists', async () => {
    const { db } = makeDb([[trainingDay], HAS_GROUP, slots, []]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.announcement).toBeNull();
  });
});

describe('ScheduleService — booking window flag', () => {
  it('bookingWindowOpen is false before 14:00', async () => {
    const { db } = makeDb([[trainingDay], HAS_GROUP, slots, []]);
    const result = await makeService(db, kyivAt(13)).getNext();
    expect(result?.bookingWindowOpen).toBe(false);
  });

  it('bookingWindowOpen is true between 14:00 and 21:00', async () => {
    const { db } = makeDb([[trainingDay], HAS_GROUP, slots, []]);
    const result = await makeService(db, kyivAt(17)).getNext();
    expect(result?.bookingWindowOpen).toBe(true);
  });

  it('bookingWindowOpen is false after 21:00', async () => {
    const { db } = makeDb([[trainingDay], HAS_GROUP, [trainingDay], HAS_GROUP, slots, []]);
    const result = await makeService(db, kyivAt(21)).getNext();
    expect(result?.bookingWindowOpen).toBe(false);
  });
});
describe('ScheduleService — personal trainings', () => {
  it('skips a day that has only personal trainings when picking the next group day', async () => {
    const personalOnly = { id: 'day-p', localDate: TODAY, status: 'SCHEDULED', isException: true };
    const groupDay = { id: 'day-2', localDate: '2026-10-21', status: 'SCHEDULED', isException: false };
    const { db } = makeDb([[personalOnly, groupDay], [{ dayId: 'day-2' }], slots, []]);
    const result = await makeService(db, kyivAt(15)).getNext();
    expect(result?.localDate).toBe('2026-10-21');
  });

  it("lists the member's assigned personal trainings until they end, with booking state", async () => {
    const assigned = [
      { id: 'p-morning', localDate: TODAY, slotTime: '12:00', trainingType: 'персональні', capacity: 1, bookedCount: 0 },
      { id: 'p-evening', localDate: TODAY, slotTime: '18:00', trainingType: 'спліт', capacity: 2, bookedCount: 1 },
    ];
    const { db } = makeDb([
      assigned,
      [{ slotId: 'p-evening', paymentStatus: 'PAID' }],
      [trainingDay], HAS_GROUP, slots, [], [], [],
    ]);
    const result = await makeService(db, kyivAt(15)).getNext('member-1');

    // 12:00 ended at 13:00, so only the evening split is shown
    expect(result?.personalSlots).toEqual([
      expect.objectContaining({ id: 'p-evening', isMyBooking: true, myPaymentStatus: 'PAID', started: false }),
    ]);
  });

  it('marks a personal training as started (no payment) during its hour', async () => {
    const assigned = [{ id: 'p1', localDate: TODAY, slotTime: '15:00', trainingType: 'персональні', capacity: 1, bookedCount: 0 }];
    const { db } = makeDb([assigned, [], [trainingDay], HAS_GROUP, slots, [], [], []]);
    const result = await makeService(db, kyivAt(15)).getNext('member-1');
    expect(result?.personalSlots).toEqual([expect.objectContaining({ id: 'p1', isMyBooking: false, started: true })]);
  });
});
