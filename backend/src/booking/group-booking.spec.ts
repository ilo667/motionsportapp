import { DateTime } from 'luxon';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { freeSeats, lockMember, tryBookGroup } from './group-booking';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';

jest.mock('../trainer-schedule/trainer-schedule.store', () => ({ loadTrainerSchedule: jest.fn() }));
const mockLoadSchedule = loadTrainerSchedule as jest.Mock;
beforeEach(() => mockLoadSchedule.mockResolvedValue({ bookingOpensAt: '14:00', autoCreate: true, times: [] }));
import { vacancyAlerts } from '../database/schema';
import { loadFreezes, memberFrozenOn, openFreeze } from '../freezes/freeze.store';

// No member is frozen unless a test says so
jest.mock('../freezes/freeze.store', () => ({
  loadFreezes: jest.fn(),
  memberFrozenOn: jest.fn(),
  openFreeze: jest.fn(),
}));
beforeEach(() => {
  (loadFreezes as jest.Mock).mockResolvedValue([]);
  (memberFrozenOn as jest.Mock).mockResolvedValue(false);
  (openFreeze as jest.Mock).mockResolvedValue(null);
});

const at = (hour: number) => DateTime.fromObject({ year: 2026, month: 10, day: 20, hour }, { zone: 'Europe/Kyiv' });

// Reads, in order: member lock, the slot locked with its day, the member's trainer, the member's group booking
// that day. Writes: the booking insert (returns its id), the seat counter
function makeTx(reads: unknown[][]) {
  const queue = [...reads];
  const inserts: unknown[] = [];
  function link(result?: () => unknown): any {
    const chain: any = {
      then: (resolve: (v: unknown) => void) => resolve(result ? result() : (queue.shift() ?? [])),
    };
    for (const m of ['from', 'innerJoin', 'where', 'for', 'limit', 'orderBy', 'set', 'returning']) {
      chain[m] = jest.fn(() => chain);
    }
    chain.values = jest.fn((v: unknown) => {
      inserts.push(v);
      return chain;
    });
    return chain;
  }
  const updates: { table: unknown; set: unknown }[] = [];
  const tx: any = {
    select: jest.fn(() => link()),
    insert: jest.fn(() => link(() => [{ id: 'booking-1' }])),
    update: jest.fn((table: unknown) => {
      const chain = link(() => undefined);
      chain.set = jest.fn((v: unknown) => {
        updates.push({ table, set: v });
        return chain;
      });
      return chain;
    }),
  };
  return { tx, inserts, updates };
}

const slot = {
  id: 'slot-1',
  status: 'ACTIVE',
  slotTime: '19:00',
  trainingType: 'групові',
  capacity: 8,
  bookedCount: 3,
  trainerId: 'trainer-1',
  trainingDayId: 'day-1',
  localDate: '2026-10-20',
  dayStatus: 'SCHEDULED',
};
const MEMBER = [{ id: 'member-1' }];
const TRAINER = [{ trainerId: 'trainer-1' }];

describe('tryBookGroup — booking inside someone else’s transaction, never throwing', () => {
  it('books and returns the booking id', async () => {
    const { tx, inserts } = makeTx([MEMBER, [slot], TRAINER, []]);
    expect(await tryBookGroup(tx, at(15), 'member-1', 'slot-1')).toEqual({ ok: true, bookingId: 'booking-1' });
    expect(inserts).toEqual([{ memberId: 'member-1', slotId: 'slot-1', status: 'ACTIVE' }]);
  });

  // Booked through «Купити разово / абонемент / готівкою»: the «Повідомити про місце» alert for this slot goes off,
  // as after «Записатись»
  it("turns off the member's vacancy alert for the slot", async () => {
    const { tx, updates } = makeTx([MEMBER, [slot], TRAINER, []]);
    await tryBookGroup(tx, at(15), 'member-1', 'slot-1');
    expect(updates).toContainEqual({ table: vacancyAlerts, set: { active: false } });
  });

  it('a member frozen on that day: FROZEN, nothing inserted', async () => {
    (memberFrozenOn as jest.Mock).mockResolvedValue(true);
    const { tx, inserts } = makeTx([MEMBER, [slot], TRAINER, []]);
    expect(await tryBookGroup(tx, at(15), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'FROZEN' });
    expect(inserts).toEqual([]);
  });

  // Cancelled late and paid for it: booking the same training again would spend it twice
  it('the member cancelled this training late: LATE_CANCELLED, nothing inserted', async () => {
    const { tx, inserts } = makeTx([MEMBER, [slot], TRAINER, [], [{ slotId: 'slot-1' }]]);
    expect(await tryBookGroup(tx, at(15), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'LATE_CANCELLED' });
    expect(inserts).toEqual([]);
  });

  it('a full slot: FULL, nothing inserted', async () => {
    const { tx, inserts } = makeTx([MEMBER, [{ ...slot, bookedCount: 8 }], TRAINER, []]);
    expect(await tryBookGroup(tx, at(15), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'FULL' });
    expect(inserts).toEqual([]);
  });

  it('already booked on a group training that day: ALREADY_BOOKED', async () => {
    const { tx } = makeTx([MEMBER, [slot], TRAINER, [{ id: 'b0', slotId: 'slot-2' }]]);
    expect(await tryBookGroup(tx, at(15), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'ALREADY_BOOKED' });
  });

  it('before the trainer opens booking or once the training started: WINDOW', async () => {
    const early = makeTx([MEMBER, [slot], TRAINER, []]);
    expect(await tryBookGroup(early.tx, at(13), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'WINDOW' });
    const started = makeTx([MEMBER, [slot], TRAINER, []]);
    expect(await tryBookGroup(started.tx, at(19), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'WINDOW' });
  });

  it("opens at the trainer's own time (12:00 here)", async () => {
    mockLoadSchedule.mockResolvedValue({ bookingOpensAt: '12:00', autoCreate: true, times: [] });
    const { tx } = makeTx([MEMBER, [slot], TRAINER, []]);
    expect(await tryBookGroup(tx, at(12), 'member-1', 'slot-1')).toEqual({ ok: true, bookingId: 'booking-1' });
    expect(mockLoadSchedule).toHaveBeenCalledWith(tx, 'trainer-1');
  });

  it('a cancelled slot or day: CANCELLED / NOT_SCHEDULED', async () => {
    const a = makeTx([MEMBER, [{ ...slot, status: 'CANCELLED' }], TRAINER, []]);
    expect(await tryBookGroup(a.tx, at(15), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'CANCELLED' });
    const b = makeTx([MEMBER, [{ ...slot, dayStatus: 'CANCELLED' }], TRAINER, []]);
    expect(await tryBookGroup(b.tx, at(15), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'NOT_SCHEDULED' });
  });

  it("another trainer's slot or an assigned one: NOT_FOUND", async () => {
    const a = makeTx([MEMBER, [{ ...slot, trainerId: 'trainer-2' }], TRAINER, []]);
    expect(await tryBookGroup(a.tx, at(15), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'NOT_FOUND' });
    const b = makeTx([MEMBER, [{ ...slot, trainingType: 'спліт' }], TRAINER, []]);
    expect(await tryBookGroup(b.tx, at(15), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('freeSeats — a booking (and its guest) gave its seats back', () => {
  it('locks the training, frees the seats, never below zero', async () => {
    const { tx, updates } = makeTx([[{ bookedCount: 3, capacity: 8, trainingType: 'групові' }]]);
    await freeSeats(tx, 'slot-1', 2);
    expect(tx.select.mock.results[0].value.for).toHaveBeenCalledWith('update');
    const { sql, params } = new PgDialect().sqlToQuery((updates[0].set as { bookedCount: SQL }).bookedCount);
    expect(sql).toBe('GREATEST("training_slots"."booked_count" - $1, 0)');
    expect(params).toEqual([2]);
  });

  it("a full group training: «З'явилось місце» is due", async () => {
    const { tx } = makeTx([[{ bookedCount: 8, capacity: 8, trainingType: 'групові' }]]);
    expect(await freeSeats(tx, 'slot-1', 1)).toBe(true);
  });

  it('not full: nothing to tell', async () => {
    const { tx } = makeTx([[{ bookedCount: 7, capacity: 8, trainingType: 'групові' }]]);
    expect(await freeSeats(tx, 'slot-1', 1)).toBe(false);
  });

  it('a full assigned training: nobody waits for it (no vacancy alerts there)', async () => {
    const { tx } = makeTx([[{ bookedCount: 1, capacity: 1, trainingType: 'персональні' }]]);
    expect(await freeSeats(tx, 'slot-p', 1)).toBe(false);
  });
});

// One member's bookings, purchases and freezes run one at a time only while this really locks the row
describe('lockMember — the member row under FOR UPDATE', () => {
  it('locks the row and returns the trainer and name', async () => {
    const forCalls: unknown[][] = [];
    const chain: any = {
      then: (resolve: (v: unknown) => void) => resolve([{ trainerId: 't1', displayName: 'Оля' }]),
    };
    for (const m of ['from', 'where', 'limit']) chain[m] = jest.fn(() => chain);
    chain.for = jest.fn((...args: unknown[]) => (forCalls.push(args), chain));
    const tx: any = { select: jest.fn(() => chain) };

    await expect(lockMember(tx, 'm1')).resolves.toEqual({ trainerId: 't1', displayName: 'Оля' });
    expect(forCalls).toEqual([['update']]);
  });

  it('null for an unknown member', async () => {
    const chain: any = { then: (resolve: (v: unknown) => void) => resolve([]) };
    for (const m of ['from', 'where', 'for', 'limit']) chain[m] = jest.fn(() => chain);
    await expect(lockMember({ select: () => chain } as any, 'nobody')).resolves.toBeNull();
  });
});
