import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DateTime } from 'luxon';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AdminTrainersService } from './admin-trainers.service';
import { AdminScheduleController } from './admin-schedule.controller';
import { SessionGuard } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import {
  adminPushSubscriptions,
  admins,
  bookings,
  members,
  purchases,
  sessions,
  trainerSchedules,
  trainingDays,
  trainingSlots,
} from '../database/schema';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';

jest.mock('../trainer-schedule/trainer-schedule.store', () => ({ loadTrainerSchedule: jest.fn() }));
const mockLoadSchedule = loadTrainerSchedule as jest.Mock;

const NOW = DateTime.fromObject({ year: 2026, month: 10, day: 26, hour: 12 }, { zone: 'Europe/Kyiv' });
const ME = 'trainer-1';
const FIRST = 'trainer-0';
const GONE = 'trainer-2';
const NEW = 'trainer-3';

// Reads and writes (RETURNING) consume their lists in order; each write is logged with table, payload, where SQL
function makeDb(reads: unknown[][], writes: unknown[][] = []) {
  let r = 0;
  let w = 0;
  const log: { op: string; table: unknown; payload?: unknown; where?: { sql: string; params: unknown[] } }[] = [];
  // 'select' or the written table, in run order
  const order: unknown[] = [];

  function readLink(): any {
    const chain: any = { then: (res: (v: unknown) => void) => res(reads[r++] ?? []) };
    for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'for']) chain[m] = () => readLink();
    return chain;
  }
  function writeLink(entry: (typeof log)[number]): any {
    let result: unknown[] | undefined;
    const chain: any = {
      then: (res: (v: unknown) => void) => {
        result ??= writes[w++] ?? [];
        res(result);
      },
    };
    for (const m of ['returning', 'onConflictDoUpdate', 'onConflictDoNothing']) chain[m] = () => chain;
    chain.set = (v: unknown) => ((entry.payload = v), chain);
    chain.values = (v: unknown) => ((entry.payload = v), chain);
    chain.where = (cond: any) => ((entry.where = new PgDialect().sqlToQuery(cond)), chain);
    return chain;
  }
  const write = (op: string) => (table: unknown) => {
    const entry = { op, table };
    log.push(entry);
    order.push(table);
    return writeLink(entry);
  };
  const db: any = {
    select: jest.fn(() => (order.push('select'), readLink())),
    update: jest.fn(write('update')),
    insert: jest.fn(write('insert')),
    delete: jest.fn(write('delete')),
    transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) => cb(db)),
  };
  return { db, log, order };
}

function makeService(db: any) {
  const notifications = { enqueueAndProcess: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminTrainersService({ db } as any, notifications as any, { now: () => NOW });
  return { service, notifications };
}

const slot = (id: string, localDate: string, slotTime: string) => ({ id, localDate, slotTime });

beforeEach(() => mockLoadSchedule.mockResolvedValue({ bookingOpensAt: '08:00', autoCreate: true, times: [] }));

describe('Disabling a trainer — refusals', () => {
  it('a trainer cannot disable themselves', async () => {
    const { db, log } = makeDb([]);
    await expect(makeService(db).service.disableTrainer(ME, ME, NEW)).rejects.toThrow(
      new BadRequestException('Cannot disable yourself'),
    );
    expect(log).toEqual([]);
  });

  it('the first trainer cannot be disabled', async () => {
    const { db, log } = makeDb([[{ id: GONE }]]);
    await expect(makeService(db).service.disableTrainer(ME, GONE, NEW)).rejects.toThrow(
      new BadRequestException('Cannot disable the first trainer'),
    );
    expect(log).toEqual([]);
  });

  it('clients cannot go to the trainer being disabled', async () => {
    const { db } = makeDb([[{ id: FIRST }]]);
    await expect(makeService(db).service.disableTrainer(ME, GONE, GONE)).rejects.toThrow(BadRequestException);
  });

  it('clients cannot go to a missing or disabled trainer (404)', async () => {
    const { db, log } = makeDb([[{ id: FIRST }], []]);
    await expect(makeService(db).service.disableTrainer(ME, GONE, NEW)).rejects.toThrow(
      new NotFoundException('Trainer not found'),
    );
    expect(log).toEqual([]);
  });

  it('a missing trainer answers 404', async () => {
    const { db } = makeDb([[{ id: FIRST }], [{ id: NEW }], []]);
    await expect(makeService(db).service.disableTrainer(ME, GONE, NEW)).rejects.toThrow(NotFoundException);
  });

  it('already disabled (the compare-and-set matched nothing): 409 and nothing else is written', async () => {
    const { db, log } = makeDb(
      [
        [{ id: FIRST }],
        [{ id: NEW }],
        [{ id: GONE }],
        [
          { id: GONE, disabledAt: null },
          { id: NEW, disabledAt: null },
        ],
      ],
      [[]],
    );
    await expect(makeService(db).service.disableTrainer(ME, GONE, NEW)).rejects.toThrow(
      new ConflictException('Trainer already disabled'),
    );
    expect(log.map((e) => e.table)).toEqual([admins]);
  });

  // Race: A disables B (clients to C) while D disables C; the recheck under lock stops B's clients landing on C
  it('the chosen trainer disabled meanwhile (seen under the row lock): 404 and nothing is written', async () => {
    const { db, log } = makeDb([
      [{ id: FIRST }],
      [{ id: NEW }],
      [{ id: GONE }],
      [
        { id: GONE, disabledAt: null },
        { id: NEW, disabledAt: new Date() },
      ],
    ]);
    await expect(makeService(db).service.disableTrainer(ME, GONE, NEW)).rejects.toThrow(
      new NotFoundException('Trainer not found'),
    );
    expect(log).toEqual([]);
  });

  it('is for signed-in trainers only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminScheduleController)).toEqual([SessionGuard, AdminGuard]);
  });
});

describe('Disabling a trainer', () => {
  // 10:30 is over (an hour after start), 11:30 is going on, tomorrow is ahead
  const slots = [
    slot('s-over', '2026-10-26', '10:30'),
    slot('s-now', '2026-10-26', '11:30'),
    slot('s-tomorrow', '2026-10-27', '19:00'),
  ];
  const booked = [
    { memberId: 'm-1', slotId: 's-now' },
    { memberId: 'm-2', slotId: 's-now' },
  ];

  async function disable() {
    const { db, log, order } = makeDb(
      [
        [{ id: FIRST }],
        [{ id: NEW }],
        [{ id: GONE }],
        [
          { id: GONE, disabledAt: null },
          { id: NEW, disabledAt: null },
        ],
        slots,
        [], // cancelSlotsTx: the slot row lock, then the bookings on them
        booked,
      ],
      [[{ id: GONE }], [], [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }]],
    );
    const { service, notifications } = makeService(db);
    const result = await service.disableTrainer(ME, GONE, NEW);
    return { result, log, notifications, order };
  }
  const writesTo = (log: any[], table: unknown) => log.filter((e) => e.table === table);

  it('says how many clients moved and how many trainings were cancelled', async () => {
    const { result } = await disable();
    expect(result).toEqual({ movedClients: 3, cancelledTrainings: 2 });
  });

  it('marks the trainer disabled by whom, compare-and-set', async () => {
    const { log } = await disable();
    const [cas] = writesTo(log, admins);
    expect(cas.payload).toEqual({ disabledAt: NOW.toJSDate(), disabledByAdminId: ME });
    expect(cas.where.sql).toContain('"admins"."disabled_at" is null');
  });

  it('signs the trainer out everywhere (their live sessions revoked)', async () => {
    const { log } = await disable();
    const [s] = writesTo(log, sessions);
    expect(s.payload).toEqual({ revokedAt: NOW.toJSDate() });
    expect(s.where.params).toEqual(expect.arrayContaining(['admin', GONE]));
  });

  it('moves every client and the cash purchases waiting for the trainer to the chosen one', async () => {
    const { log } = await disable();
    const [m] = writesTo(log, members);
    expect(m.payload).toEqual({ trainerId: NEW });
    expect(m.where.params).toEqual([GONE]);
    const [p] = writesTo(log, purchases);
    expect(p.payload).toEqual({ trainerId: NEW });
    expect(p.where.params).toEqual(expect.arrayContaining([GONE, 'PENDING', 'CASH']));
  });

  it('cancels the trainings not over yet (going on and ahead), not the one that is over; the day stays', async () => {
    const { log } = await disable();
    const slotWrite = writesTo(log, trainingSlots).find((e: any) => e.payload?.status === 'CANCELLED');
    expect(slotWrite.payload).toEqual({ status: 'CANCELLED', bookedCount: 0, cancelledAt: expect.any(Date) });
    expect(slotWrite.where.params).toEqual(['s-now', 's-tomorrow']);
    const bookingWrite = writesTo(log, bookings).find((e: any) => e.payload?.status === 'CANCELLED');
    expect(bookingWrite.where.params).toEqual(expect.arrayContaining(['s-now', 's-tomorrow']));
    expect(writesTo(log, trainingDays)).toEqual([]);
  });

  // Reading slots last, under lock, means a concurrent booking is either refused or notified
  it('reads the trainings to cancel inside the transaction, after disabling and switching auto-add off', async () => {
    const { order } = await disable();
    const selects = order.map((t, i) => (t === 'select' ? i : -1)).filter((i) => i >= 0);
    const slotsRead = selects[4]; // default trainer, target, trainer, row lock, then the slots
    expect(order.indexOf(admins)).toBeLessThan(slotsRead);
    expect(order.indexOf(trainerSchedules)).toBeLessThan(slotsRead);
  });

  it("switches the trainer's push subscriptions off (no trainer pushes on that phone any more)", async () => {
    const { log } = await disable();
    const [p] = writesTo(log, adminPushSubscriptions);
    expect(p.payload).toEqual({ disabledAt: NOW.toJSDate() });
    expect(p.where.params).toEqual([GONE]);
  });

  it('switches automatic group trainings off, keeping the opening time', async () => {
    const { log } = await disable();
    const [s] = writesTo(log, trainerSchedules);
    expect(s.payload).toEqual(expect.objectContaining({ trainerId: GONE, bookingOpensAt: '08:00', autoCreate: false }));
  });

  it('tells the booked members their training is cancelled, once per training with members', async () => {
    const { notifications } = await disable();
    expect(notifications.enqueueAndProcess).toHaveBeenCalledTimes(1);
    expect(notifications.enqueueAndProcess).toHaveBeenCalledWith('SLOT_CANCELLED', 'slot-cancelled:s-now:2026-10-26', {
      memberIds: ['m-1', 'm-2'],
      slotTime: '11:30',
      localDate: '2026-10-26',
    });
  });
});
