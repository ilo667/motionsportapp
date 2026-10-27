import { ConflictException, NotFoundException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DateTime } from 'luxon';
import { FreezesService } from './freezes.service';
import { openFreeze } from './freeze.store';
import { freeSeats } from '../booking/group-booking';
import { bookings, clubCards, freezeItems, freezes, packages } from '../database/schema';

jest.mock('./freeze.store', () => ({ openFreeze: jest.fn() }));
// Freeing seats is tested in group-booking.spec; here only the 19:00 on Wednesday was full
jest.mock('../booking/group-booking', () => ({
  ...jest.requireActual('../booking/group-booking'),
  freeSeats: jest.fn(),
}));
const mockFreeSeats = freeSeats as jest.Mock;
beforeEach(() =>
  mockFreeSeats.mockImplementation((_tx: unknown, slotId: string) => Promise.resolve(slotId === 's-wed')),
);
const mockOpenFreeze = openFreeze as jest.Mock;
beforeEach(() => mockOpenFreeze.mockResolvedValue(null));

// Monday 26.10.2026, 12:00 Kyiv
const NOW = DateTime.fromISO('2026-10-26T12:00:00', { zone: 'Europe/Kyiv' });
const TODAY = '2026-10-26';

type Write = { op: 'update' | 'insert'; table: unknown; set?: Record<string, unknown>; values?: unknown };

// Drizzle mock: each awaited read takes the next of `reads`; a write with .returning() takes the next of `returns`.
// Writes are recorded with their table, so tests can say what changed; reads' WHERE conditions in `wheres`
function makeDb(reads: unknown[][], returns: unknown[][] = []) {
  let r = 0;
  let w = 0;
  const writes: Write[] = [];
  const wheres: SQL[] = [];

  function readLink(): any {
    const chain: any = { then: (resolve: (v: unknown) => void) => resolve(reads[r++] ?? []) };
    for (const m of ['from', 'innerJoin', 'leftJoin', 'for', 'orderBy', 'limit']) {
      chain[m] = jest.fn().mockImplementation(() => readLink());
    }
    chain.where = jest.fn().mockImplementation((cond: SQL) => (wheres.push(cond), readLink()));
    return chain;
  }

  function writeLink(write: Write, returning = false): any {
    const chain: any = {
      then: (resolve: (v: unknown) => void) => resolve(returning ? (returns[w++] ?? []) : undefined),
    };
    chain.set = jest.fn().mockImplementation((v: Record<string, unknown>) => {
      write.set = v;
      return writeLink(write);
    });
    chain.values = jest.fn().mockImplementation((v: unknown) => {
      write.values = v;
      return writeLink(write);
    });
    chain.where = jest.fn().mockImplementation(() => writeLink(write, returning));
    chain.returning = jest.fn().mockImplementation(() => writeLink(write, true));
    return chain;
  }

  const db: any = {
    select: jest.fn().mockImplementation(() => readLink()),
    update: jest.fn().mockImplementation((table: unknown) => {
      const write: Write = { op: 'update', table };
      writes.push(write);
      return writeLink(write);
    }),
    insert: jest.fn().mockImplementation((table: unknown) => {
      const write: Write = { op: 'insert', table };
      writes.push(write);
      return writeLink(write);
    }),
    transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<unknown>) => cb(db)),
  };
  return { db, writes, wheres };
}

const render = (cond: SQL) => new PgDialect().sqlToQuery(cond);

// The number a date shift adds: `valid_until + ${days}::int`
function shiftOf(set: Record<string, unknown>) {
  const chunks = (Object.values(set)[0] as { queryChunks: unknown[] }).queryChunks;
  return chunks.find((c) => typeof c === 'number');
}

function makeService(db: any, { card = null, packs = [] }: { card?: unknown; packs?: unknown[] } = {}) {
  const entitlements = {
    usableCard: jest.fn().mockResolvedValue(card),
    packagesOf: jest.fn().mockResolvedValue(packs),
  };
  const notifications = { enqueueAndProcess: jest.fn().mockResolvedValue(undefined) };
  const svc = new FreezesService({ db } as any, { now: () => NOW }, entitlements as any, notifications as any);
  return { svc, notifications };
}

const MEMBER = [{ trainerId: 'trainer-1', displayName: 'Катя' }];
const VISIBLE = [{ memberId: 'm1' }];

describe('FreezesService — request', () => {
  it('asks the trainer', async () => {
    const { db, writes } = makeDb([MEMBER, []], [[{ id: 'f1' }]]);
    const { svc, notifications } = makeService(db, { card: { id: 'c1' } });
    await svc.request('m1');
    expect(writes[0]).toMatchObject({ op: 'insert', table: freezes, values: { memberId: 'm1', status: 'REQUESTED' } });
    expect(notifications.enqueueAndProcess).toHaveBeenCalledWith('FREEZE_REQUESTED', 'freeze-requested:f1', {
      trainerId: 'trainer-1',
      displayName: 'Катя',
      kind: 'freeze',
    });
  });

  it('one at a time', async () => {
    mockOpenFreeze.mockResolvedValue({ id: 'f0', status: 'REQUESTED' });
    const { db } = makeDb([MEMBER]);
    await expect(makeService(db, { card: { id: 'c1' } }).svc.request('m1')).rejects.toThrow('Freeze already requested');
  });

  it('not while a purchase awaits payment', async () => {
    const { db } = makeDb([MEMBER, [{ id: 'p1' }]]);
    await expect(makeService(db, { card: { id: 'c1' } }).svc.request('m1')).rejects.toThrow('Purchase pending');
  });

  it('needs a card or trainings to freeze', async () => {
    const { db } = makeDb([MEMBER, []]);
    const used = [{ state: 'used' }, { state: 'burned' }];
    await expect(makeService(db, { packs: used }).svc.request('m1')).rejects.toThrow('Nothing to freeze');
  });
});

describe('FreezesService — approve', () => {
  const cards = [
    { id: 'card-active', activateBy: '2026-09-30', validFrom: '2026-09-15', validUntil: '2026-11-15' },
    { id: 'card-ended', activateBy: '2026-08-30', validFrom: '2026-08-01', validUntil: '2026-09-01' },
  ];
  const packs = [
    {
      id: 'pack-waiting',
      total: 8,
      used: 0,
      purchasedOn: '2026-10-20',
      activateBy: '2026-11-20',
      activatedOn: null,
      validUntil: null,
    },
    {
      id: 'pack-used',
      total: 1,
      used: 1,
      purchasedOn: '2026-10-01',
      activateBy: '2026-11-01',
      activatedOn: '2026-10-05',
      validUntil: '2026-11-05',
    },
  ];
  const items = [
    { clubCardId: 'card-active', packageId: null, field: 'valid_until' },
    { clubCardId: null, packageId: 'pack-waiting', field: 'activate_by' },
  ];
  const toCancel = [
    { id: 'b-started', slotId: 's-today-9', slotTime: '09:00', localDate: TODAY },
    { id: 'b-full', slotId: 's-wed', slotTime: '19:00', localDate: '2026-10-28' },
    { id: 'b-split', slotId: 's-split', slotTime: '10:00', localDate: '2026-11-02' },
  ];

  it('freezes for 30 days, pushes the dates of what is waiting or active, cancels trainings ahead', async () => {
    const { db, writes } = makeDb([VISIBLE, MEMBER, cards, packs, items, toCancel], [[{ memberId: 'm1' }]]);
    const { svc, notifications } = makeService(db);
    await svc.approve('trainer-1', 'f1');

    const freeze = writes.find((w) => w.table === freezes)!;
    expect(freeze.set).toMatchObject({
      status: 'ACTIVE',
      startedOn: TODAY,
      endsOn: '2026-11-25',
      decidedBy: 'trainer-1',
    });
    expect(writes.find((w) => w.table === freezeItems)!.values).toEqual([
      { freezeId: 'f1', clubCardId: 'card-active', field: 'valid_until' },
      { freezeId: 'f1', packageId: 'pack-waiting', field: 'activate_by' },
    ]);
    const card = writes.find((w) => w.table === clubCards)!;
    expect(Object.keys(card.set!)).toEqual(['validUntil']);
    expect(shiftOf(card.set!)).toBe(30);
    const pack = writes.find((w) => w.table === packages)!;
    expect(Object.keys(pack.set!)).toEqual(['activateBy']);
    expect(shiftOf(pack.set!)).toBe(30);

    // The 09:00 training today has started: it stays. The other two lose a seat each
    expect(writes.find((w) => w.table === bookings)!.set).toMatchObject({ status: 'CANCELLED' });
    expect(mockFreeSeats.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['s-wed', 1],
      ['s-split', 1],
    ]);
    // A seat freed in a full group training: «З'явилось місце»
    const vacancy = notifications.enqueueAndProcess.mock.calls.filter((c) => c[0] === 'VACANCY');
    expect(vacancy).toEqual([
      ['VACANCY', 'vacancy:s-wed:b-full', expect.objectContaining({ slotId: 's-wed', excludeMemberId: 'm1' })],
    ]);
    expect(notifications.enqueueAndProcess).toHaveBeenCalledWith('FREEZE_DECIDED', 'freeze-decided:f1', {
      memberId: 'm1',
      kind: 'freeze',
      approved: true,
      until: '2026-11-24',
    });
  });

  it("a booking's guest goes with it: two seats freed", async () => {
    mockFreeSeats.mockClear();
    const { db } = makeDb([VISIBLE, MEMBER, [], [], toCancel], [[{ memberId: 'm1' }], [{ bookingId: 'b-full' }]]);
    await makeService(db).svc.approve('trainer-1', 'f1');
    expect(mockFreeSeats.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['s-wed', 2],
      ['s-split', 1],
    ]);
  });

  it('a decided request answers 409', async () => {
    const { db } = makeDb([VISIBLE, MEMBER], [[]]);
    await expect(makeService(db).svc.approve('trainer-1', 'f1')).rejects.toThrow(ConflictException);
  });

  it("another trainer's client answers 404", async () => {
    const { db } = makeDb([[]]);
    await expect(makeService(db).svc.approve('trainer-2', 'f1')).rejects.toThrow(NotFoundException);
  });
});

describe('FreezesService — unfreeze', () => {
  it('ends today and moves the pushed dates back by the days left', async () => {
    const items = [{ clubCardId: 'c1', packageId: null, field: 'valid_until' }];
    const { db, writes, wheres } = makeDb([VISIBLE, [{ memberId: 'm1', endsOn: '2026-11-20' }], items]);
    const { svc, notifications } = makeService(db);
    await svc.approveUnfreeze('trainer-1', 'f1');

    // Only an asked unfreeze of a freeze not over yet
    const { sql, params } = render(wheres[1]);
    expect(sql).toBe(
      '("freezes"."id" = $1 and ("freezes"."status" = $2 and "freezes"."unfreeze_requested_at" is not null and "freezes"."ends_on" > $3))',
    );
    expect(params).toEqual(['f1', 'ACTIVE', TODAY]);

    expect(writes.find((w) => w.table === freezes)!.set).toMatchObject({
      endsOn: TODAY,
      unfreezeDecidedBy: 'trainer-1',
    });
    expect(shiftOf(writes.find((w) => w.table === clubCards)!.set!)).toBe(-25);
    expect(notifications.enqueueAndProcess).toHaveBeenCalledWith(
      'FREEZE_DECIDED',
      expect.stringMatching(/^unfreeze-decided:f1:/),
      { memberId: 'm1', kind: 'unfreeze', approved: true },
    );
  });

  it('nothing to unfreeze (not asked, already over or decided) answers 409', async () => {
    const { db } = makeDb([VISIBLE, []]);
    await expect(makeService(db).svc.approveUnfreeze('trainer-1', 'f1')).rejects.toThrow(ConflictException);
  });

  it('asking twice answers 409', async () => {
    const { db } = makeDb([], [[]]);
    await expect(makeService(db).svc.requestUnfreeze('m1')).rejects.toThrow('Nothing to unfreeze');
  });

  it('rejected: the freeze goes on, the member may ask again', async () => {
    const { db, writes } = makeDb([VISIBLE], [[{ memberId: 'm1' }]]);
    await makeService(db).svc.rejectUnfreeze('trainer-1', 'f1');
    expect(writes[0]).toMatchObject({ table: freezes, set: { unfreezeRequestedAt: null } });
  });
});

describe('FreezesService — pending', () => {
  it('a request shows the last day it would freeze; an unfreeze the current one', async () => {
    const requestedAt = new Date('2026-10-25T10:00:00Z');
    const { db, wheres } = makeDb([
      [
        { id: 'f1', memberId: 'm1', displayName: 'Катя', status: 'REQUESTED', requestedAt, endsOn: null },
        {
          id: 'f2',
          memberId: 'm2',
          displayName: 'Оля',
          status: 'ACTIVE',
          requestedAt,
          endsOn: '2026-11-10',
          unfreezeRequestedAt: new Date('2026-10-26T08:00:00Z'),
        },
      ],
    ]);
    const rows = await makeService(db).svc.pending('trainer-1');
    // Freeze requests, and unfreezes asked while the freeze goes on
    const { sql, params } = render(wheres[0]);
    expect(sql).toContain(
      '("freezes"."status" = $2 or ("freezes"."status" = $3 and "freezes"."unfreeze_requested_at" is not null and "freezes"."ends_on" > $4))',
    );
    expect(params.slice(1)).toEqual(['REQUESTED', 'ACTIVE', TODAY]);
    expect(rows.map((r) => [r.id, r.kind, r.until])).toEqual([
      ['f1', 'freeze', '2026-11-24'],
      ['f2', 'unfreeze', '2026-11-09'],
    ]);
  });
});
