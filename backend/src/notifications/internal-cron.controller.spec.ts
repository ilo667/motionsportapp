import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DateTime } from 'luxon';
import { InternalCronController } from './internal-cron.controller';

function makeController(db: any = {}, entitlements: any = {}) {
  const paymentService = { expireStale: jest.fn().mockResolvedValue({ expired: 0 }) };
  const clock = { now: () => DateTime.fromISO('2026-10-23T22:00:00', { zone: 'Europe/Kyiv' }) };
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
        { id: 'b1', trainerId: 'trainer-2' },
        { id: 'b2', trainerId: 'trainer-1' },
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
});
