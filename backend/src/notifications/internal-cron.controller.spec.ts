import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DateTime } from 'luxon';
import { InternalCronController } from './internal-cron.controller';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';

jest.mock('../trainer-schedule/trainer-schedule.store', () => ({ loadTrainerSchedule: jest.fn() }));
const mockLoadSchedule = loadTrainerSchedule as jest.Mock;

function makeController(db: any = {}, entitlements: any = {}, at = '2026-10-23T22:00:00') {
  const paymentService = { expireStale: jest.fn().mockResolvedValue({ expired: 0 }) };
  const clock = { now: () => DateTime.fromISO(at, { zone: 'Europe/Kyiv' }) };
  const controller = new InternalCronController(
    { db } as any,
    {} as any,
    {} as any,
    clock,
    paymentService as any,
    entitlements,
  );
  return { controller, paymentService };
}

describe('InternalCronController — cron secret', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('rejects when CRON_SECRET is missing in production', async () => {
    delete process.env.CRON_SECRET;
    process.env.NODE_ENV = 'production';
    const { controller, paymentService } = makeController();
    await expect(controller.expirePayments(undefined as any)).rejects.toThrow(ForbiddenException);
    expect(paymentService.expireStale).not.toHaveBeenCalled();
  });

  it('allows manual runs without CRON_SECRET outside production', async () => {
    delete process.env.CRON_SECRET;
    process.env.NODE_ENV = 'development';
    const { controller } = makeController();
    await expect(controller.expirePayments(undefined as any)).resolves.toEqual({ expired: 0 });
  });

  it('rejects a wrong or missing Authorization header', async () => {
    process.env.CRON_SECRET = 'secret-1234567890';
    const { controller, paymentService } = makeController();
    await expect(controller.expirePayments('Bearer wrong')).rejects.toThrow(ForbiddenException);
    await expect(controller.expirePayments(undefined as any)).rejects.toThrow(ForbiddenException);
    expect(paymentService.expireStale).not.toHaveBeenCalled();
  });

  it('runs the job with the correct Bearer secret', async () => {
    process.env.CRON_SECRET = 'secret-1234567890';
    const { controller, paymentService } = makeController();
    await expect(controller.expirePayments('Bearer secret-1234567890')).resolves.toEqual({ expired: 0 });
    expect(paymentService.expireStale).toHaveBeenCalled();
  });
});

describe('InternalCronController — routes', () => {
  // Vercel Cron invokes with GET — a POST route answers 404 and the job silently never runs
  it.each(['bookingOpen', 'generateAnnouncement', 'autoConfirmAttendance', 'expirePayments'] as const)(
    '%s is a GET route',
    (handler) => {
      expect(Reflect.getMetadata(METHOD_METADATA, InternalCronController.prototype[handler])).toBe(RequestMethod.GET);
    },
  );
});

describe('InternalCronController — 22:00 auto-confirm', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("marks unmarked bookings PRESENT in the slot trainer's name and spends from packages", async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CRON_SECRET;
    const reads: unknown[][] = [
      [{ id: 'day-1', status: 'SCHEDULED' }],
      [{ id: 'slot-1' }, { id: 'slot-2' }],
      [
        { id: 'b1', memberId: 'm1', trainerId: 'trainer-2', slotTime: '19:00' },
        { id: 'b2', memberId: 'm2', trainerId: 'trainer-1', slotTime: '20:00' },
      ],
    ];
    const values: Record<string, unknown>[] = [];
    function link(): any {
      const chain: any = { then: (r: (v: unknown) => void) => r(reads.shift() ?? []) };
      for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin', 'onConflictDoNothing'])
        chain[m] = () => chain;
      chain.values = (v: Record<string, unknown>) => {
        values.push(v);
        return chain;
      };
      return chain;
    }
    const db: any = { select: () => link(), insert: () => link() };
    db.transaction = (fn: (tx: unknown) => unknown) => fn(db);
    const entitlements = { syncSpend: jest.fn() };

    const { controller } = makeController(db, entitlements);
    await expect(controller.autoConfirmAttendance(undefined as any)).resolves.toMatchObject({ marked: 2 });

    expect(values.map((v) => [v.bookingId, v.markedByAdminId])).toEqual([
      ['b1', 'trainer-2'],
      ['b2', 'trainer-1'],
    ]);
    expect(entitlements.syncSpend.mock.calls.map((c: unknown[]) => c[1])).toEqual(['b1', 'b2']);
  });

  // Same lock order as «Підтвердити всіх», so the two never deadlock
  it('marks members in a fixed order (by member id, then booking id)', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CRON_SECRET;
    const reads: unknown[][] = [
      [{ id: 'day-1', status: 'SCHEDULED' }],
      [{ id: 'slot-1' }],
      [
        { id: 'b3', memberId: 'm-b', trainerId: 't', slotTime: '19:00' },
        { id: 'b2', memberId: 'm-a', trainerId: 't', slotTime: '19:00' },
        { id: 'b1', memberId: 'm-b', trainerId: 't', slotTime: '20:00' },
      ],
    ];
    function link(): any {
      const chain: any = { then: (r: (v: unknown) => void) => r(reads.shift() ?? []) };
      for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin', 'onConflictDoNothing', 'values'])
        chain[m] = () => chain;
      return chain;
    }
    const db: any = { select: () => link(), insert: () => link() };
    db.transaction = (fn: (tx: unknown) => unknown) => fn(db);
    const entitlements = { syncSpend: jest.fn() };

    const { controller } = makeController(db, entitlements);
    await controller.autoConfirmAttendance(undefined as any);
    expect(entitlements.syncSpend.mock.calls.map((c: unknown[]) => c[1])).toEqual(['b2', 'b1', 'b3']);
  });
});

describe('InternalCronController — auto-confirm only marks trainings that are over', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  // Vercel runs crons in UTC: «0 20 * * *» is 22:00 in Kyiv in winter but 23:00 in summer, and the old 19 UTC was
  // 21:00 in winter. Whatever the hour, a training still going on (or not started) is left alone
  it('at 21:00 marks the 19:00 training (over at 20:00) but not 20:30', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CRON_SECRET;
    const reads: unknown[][] = [
      [{ id: 'day-1', status: 'SCHEDULED' }],
      [{ id: 'slot-1' }, { id: 'slot-2' }],
      [
        { id: 'b-early', memberId: 'm1', trainerId: 't', slotTime: '19:00' },
        { id: 'b-late', memberId: 'm2', trainerId: 't', slotTime: '20:30' },
      ],
    ];
    function link(): any {
      const chain: any = { then: (r: (v: unknown) => void) => r(reads.shift() ?? []) };
      for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin', 'onConflictDoNothing', 'values'])
        chain[m] = () => chain;
      return chain;
    }
    const db: any = { select: () => link(), insert: () => link() };
    db.transaction = (fn: (tx: unknown) => unknown) => fn(db);
    const entitlements = { syncSpend: jest.fn() };

    const { controller } = makeController(db, entitlements, '2026-10-26T21:00:00');
    await expect(controller.autoConfirmAttendance(undefined as any)).resolves.toMatchObject({ marked: 1 });
    expect(entitlements.syncSpend.mock.calls.map((c: unknown[]) => c[1])).toEqual(['b-early']);
  });
});

describe('InternalCronController — «Записуйтесь» at each trainer opening time', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  // t1 opens at 10:00 (first group 18:00) and is the first trainer; t2 opens at 16:00 (first group 19:00)
  async function runAt(hour: number, minute = 5, times?: { trainerId: string; slotTime: string }[]) {
    process.env.NODE_ENV = 'development';
    delete process.env.CRON_SECRET;
    mockLoadSchedule.mockImplementation((_db: unknown, id: string) =>
      Promise.resolve({ bookingOpensAt: id === 't1' ? '10:00' : '16:00', autoCreate: true, times: [] }),
    );
    // reads: today's day, the active group trainings today (trainer + time), the first trainer
    const reads: unknown[][] = [
      [{ id: 'day-1', status: 'SCHEDULED' }],
      times ?? [
        { trainerId: 't1', slotTime: '18:00' },
        { trainerId: 't2', slotTime: '19:00' },
      ],
      [{ id: 't1' }],
    ];
    function link(): any {
      const chain: any = { then: (r: (v: unknown) => void) => r(reads.shift() ?? []) };
      for (const m of ['from', 'where', 'limit', 'orderBy', 'groupBy']) chain[m] = () => chain;
      return chain;
    }
    const db: any = { select: () => link() };
    const notifications = { enqueueAndProcess: jest.fn().mockResolvedValue(undefined) };
    const clock = { now: () => DateTime.fromISO('2026-10-23T00:00:00', { zone: 'Europe/Kyiv' }).set({ hour, minute }) };
    const controller = new InternalCronController(
      { db } as any,
      notifications as any,
      {} as any,
      clock,
      {} as any,
      {} as any,
    );
    await controller.bookingOpen(undefined as any);
    return notifications.enqueueAndProcess.mock.calls;
  }

  it("at 10:05 only t1's clients, keyed per trainer and day; they include clients with no trainer", async () => {
    expect(await runAt(10)).toEqual([
      [
        'BOOKING_OPEN',
        'booking-open:2026-10-23:t1',
        { localDate: '2026-10-23', trainerIds: ['t1'], includeUnassigned: true },
      ],
    ]);
  });

  it('at 16:05 both (t1 again is dropped by its dedupe key)', async () => {
    expect((await runAt(16)).map((c) => c[1])).toEqual(['booking-open:2026-10-23:t1', 'booking-open:2026-10-23:t2']);
  });

  it("at 18:30 only t2: t1's first group training already started", async () => {
    const calls = await runAt(18, 30);
    expect(calls.map((c) => c[1])).toEqual(['booking-open:2026-10-23:t2']);
    expect(calls[0][2]).toMatchObject({ trainerIds: ['t2'], includeUnassigned: false });
  });

  // A one-off 09:00 added before t1 opens at 10:00 must not close the push window for the 18:00 one
  it('a group training before the opening time does not stop the push for the later ones', async () => {
    const calls = await runAt(10, 5, [
      { trainerId: 't1', slotTime: '09:00' },
      { trainerId: 't1', slotTime: '18:00' },
    ]);
    expect(calls.map((c) => c[1])).toEqual(['booking-open:2026-10-23:t1']);
  });

  it('before anyone opens: nothing', async () => {
    expect(await runAt(9)).toEqual([]);
  });
});
