import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DateTime } from 'luxon';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AdminScheduleService } from './admin-schedule.service';
import { CreateAssignedSlotDto } from './dto/create-assigned-slot.dto';
import { attendance, packageSpends } from '../database/schema';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';

jest.mock('../trainer-schedule/trainer-schedule.store', () => ({ loadTrainerSchedule: jest.fn() }));
const mockLoadSchedule = loadTrainerSchedule as jest.Mock;
beforeEach(() => mockLoadSchedule.mockResolvedValue({ bookingOpensAt: '14:00', autoCreate: true, times: [] }));

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const M3 = '33333333-3333-4333-8333-333333333333';
const M4 = '44444444-4444-4444-8444-444444444444';

// Reads consume `reads` in order. Writes resolve to `writeResult()` (what INSERT … RETURNING gives back);
// every .values() / .set() payload is recorded
function makeDb(reads: unknown[][] = [], writeResult: () => unknown[] = () => [{ id: 'slot-new' }]) {
  let idx = 0;
  const values: unknown[] = [];
  const sets: Record<string, unknown>[] = [];

  function readLink(): any {
    const chain: any = { then: (r: (v: unknown) => void) => r(reads[idx++] ?? []) };
    for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'for', 'orderBy', 'limit'])
      chain[m] = jest.fn(() => readLink());
    return chain;
  }
  function writeLink(): any {
    const chain: any = { then: (r: (v: unknown) => void) => r(writeResult()) };
    for (const m of ['where', 'onConflictDoUpdate', 'onConflictDoNothing', 'returning'])
      chain[m] = jest.fn(() => writeLink());
    chain.values = jest.fn((v: unknown) => {
      values.push(v);
      return writeLink();
    });
    chain.set = jest.fn((v: Record<string, unknown>) => {
      sets.push(v);
      return writeLink();
    });
    return chain;
  }

  const db: any = {
    select: jest.fn(() => readLink()),
    insert: jest.fn(() => writeLink()),
    update: jest.fn(() => writeLink()),
    delete: jest.fn(() => writeLink()),
    transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) => cb(db)),
  };
  return { db, values, sets };
}

const TRAINER = 'trainer-1';
const now = DateTime.fromObject({ year: 2026, month: 10, day: 20, hour: 12 }, { zone: 'Europe/Kyiv' });

function makeService(db: any, entitlements: any = { syncSpend: jest.fn() }) {
  return new AdminScheduleService({ db } as any, {} as any, { now: () => now }, entitlements);
}

async function errorsOf(cls: any, body: object) {
  return validate(plainToInstance(cls, body));
}

describe('Assigned slots — DTO validation', () => {
  const valid = { slotTime: '18:15', trainingType: 'спліт', memberIds: [M1, M2] };

  it('accepts any time in 15-minute steps', async () => {
    expect(await errorsOf(CreateAssignedSlotDto, valid)).toHaveLength(0);
    expect(await errorsOf(CreateAssignedSlotDto, { ...valid, slotTime: '07:45' })).toHaveLength(0);
  });

  it('rejects other minutes and malformed times', async () => {
    expect(await errorsOf(CreateAssignedSlotDto, { ...valid, slotTime: '18:10' })).not.toHaveLength(0);
    expect(await errorsOf(CreateAssignedSlotDto, { ...valid, slotTime: '24:00' })).not.toHaveLength(0);
  });

  it('rejects групові as an assigned slot type', async () => {
    expect(await errorsOf(CreateAssignedSlotDto, { ...valid, trainingType: 'групові' })).not.toHaveLength(0);
  });

  it('requires 1 to 3 distinct members', async () => {
    expect(await errorsOf(CreateAssignedSlotDto, { ...valid, memberIds: [] })).not.toHaveLength(0);
    expect(await errorsOf(CreateAssignedSlotDto, { ...valid, memberIds: [M1, M2, M3, M4] })).not.toHaveLength(0);
    expect(await errorsOf(CreateAssignedSlotDto, { ...valid, memberIds: [M1, M1] })).not.toHaveLength(0);
  });
});

describe('Assigned slots — createAssignedSlot', () => {
  it('creates a split for 2 members: capacity 3 and one slot_members row each', async () => {
    const { db, values } = makeDb([[{ id: M1 }, { id: M2 }]]);
    const result = await makeService(db).createAssignedSlot(TRAINER, '2026-10-21', {
      slotTime: '10:30',
      trainingType: 'спліт',
      memberIds: [M1, M2],
    });

    expect(result).toEqual({ ok: true, slotId: 'slot-new' });
    expect(values).toContainEqual(
      expect.objectContaining({ slotTime: '10:30', trainingType: 'спліт', capacity: 3, bookedCount: 2 }),
    );
    expect(values).toContainEqual([
      { slotId: 'slot-new', memberId: M1 },
      { slotId: 'slot-new', memberId: M2 },
    ]);
    // Assigning is booking: both are on the training right away, nothing to pay per training
    expect(values).toContainEqual([
      { memberId: M1, slotId: 'slot-new', status: 'ACTIVE' },
      { memberId: M2, slotId: 'slot-new', status: 'ACTIVE' },
    ]);
  });

  it('allows exactly one member for a personal training', async () => {
    const { db } = makeDb([[{ id: M1 }, { id: M2 }]]);
    await expect(
      makeService(db).createAssignedSlot(TRAINER, '2026-10-21', {
        slotTime: '10:30',
        trainingType: 'персональні',
        memberIds: [M1, M2],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFound when a member does not exist', async () => {
    const { db } = makeDb([[{ id: M1 }]]);
    await expect(
      makeService(db).createAssignedSlot(TRAINER, '2026-10-21', {
        slotTime: '10:30',
        trainingType: 'спліт',
        memberIds: [M1, M2],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses a time that has already passed', async () => {
    const { db } = makeDb([[{ id: M1 }]]);
    await expect(
      makeService(db).createAssignedSlot(TRAINER, '2026-10-20', {
        slotTime: '11:45',
        trainingType: 'персональні',
        memberIds: [M1],
      }),
    ).rejects.toThrow('in the past');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns 409 when another active training is at that time (nothing re-used)', async () => {
    // ensureDay returns the day, the slot upsert's WHERE status = CANCELLED matches nothing
    let call = 0;
    const { db } = makeDb([[{ id: M1 }]], () => (call++ === 0 ? [{ id: 'day-1' }] : []));
    await expect(
      makeService(db).createAssignedSlot(TRAINER, '2026-10-21', {
        slotTime: '19:00',
        trainingType: 'персональні',
        memberIds: [M1],
      }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('Assigned slots — updateSlotMembers', () => {
  const split = { id: 'slot-1', trainingType: 'спліт', status: 'ACTIVE', trainerId: TRAINER };

  // Reads: the slot, the members check, who is on the slot now, their active bookings with marks
  const onSlot = (...ids: string[]) => ids.map((memberId) => ({ memberId }));

  it('cannot remove a member whose attendance is already marked', async () => {
    const { db } = makeDb([
      [split],
      [{ id: M2 }, { id: M3 }],
      onSlot(M1, M2, M3),
      [{ id: 'b1', memberId: M1, marked: 'b1' }],
    ]);
    await expect(makeService(db).updateSlotMembers(TRAINER, 'slot-1', [M2, M3])).rejects.toThrow(
      'Attendance already marked',
    );
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('removing a member who was not marked cancels their booking (no reason: not shown as theirs)', async () => {
    const { db, sets } = makeDb([
      [split],
      [{ id: M2 }, { id: M3 }],
      onSlot(M1, M2, M3),
      [
        { id: 'b1', memberId: M1, marked: null },
        { id: 'b2', memberId: M2, marked: null },
        { id: 'b3', memberId: M3, marked: null },
      ],
    ]);
    await makeService(db).updateSlotMembers(TRAINER, 'slot-1', [M2, M3]);
    expect(sets).toContainEqual(expect.objectContaining({ status: 'CANCELLED' }));
    expect(sets).not.toContainEqual(expect.objectContaining({ cancellationReason: expect.anything() }));
    expect(sets).toContainEqual({ bookedCount: 2 });
  });

  it('a newly added member is booked right away', async () => {
    const { db, values, sets } = makeDb([
      [split],
      [{ id: M1 }, { id: M2 }],
      onSlot(M1),
      [{ id: 'b1', memberId: M1, marked: null }],
    ]);
    await makeService(db).updateSlotMembers(TRAINER, 'slot-1', [M1, M2]);
    expect(values).toContainEqual([{ memberId: M2, slotId: 'slot-1', status: 'ACTIVE' }]);
    expect(sets).toContainEqual({ bookedCount: 2 });
  });

  it('a member who cancelled themselves stays unbooked when the trainer saves the same list', async () => {
    const { db, values } = makeDb([[split], [{ id: M1 }], onSlot(M1), []]);
    await makeService(db).updateSlotMembers(TRAINER, 'slot-1', [M1]);
    expect(values).not.toContainEqual([expect.objectContaining({ status: 'ACTIVE' })]);
  });

  it('replaces members without changing capacity', async () => {
    const { db, values, sets } = makeDb([
      [split],
      [{ id: M1 }, { id: M2 }, { id: M3 }],
      onSlot(M1),
      [{ id: 'b1', memberId: M1, marked: null }],
    ]);
    await makeService(db).updateSlotMembers(TRAINER, 'slot-1', [M1, M2, M3]);
    expect(values).toContainEqual([M1, M2, M3].map((memberId) => ({ slotId: 'slot-1', memberId })));
    expect(sets).not.toContainEqual(expect.objectContaining({ capacity: expect.anything() }));
  });

  it('refuses group slots (open to everyone)', async () => {
    const { db } = makeDb([[{ ...split, trainingType: 'групові' }]]);
    await expect(makeService(db).updateSlotMembers(TRAINER, 'slot-1', [M1])).rejects.toThrow(BadRequestException);
  });
});

describe('Attendance spends from the package', () => {
  it('a mark (✓ or ✗) and «—» both keep the package in step, in the same transaction', async () => {
    for (const status of ['PRESENT', 'ABSENT', 'UNMARKED'] as const) {
      const entitlements = { syncSpend: jest.fn() };
      const { db } = makeDb([[{ id: 'b1' }]]);
      await makeService(db, entitlements).updateBookingAttendance('b1', { status }, TRAINER);
      expect(entitlements.syncSpend).toHaveBeenCalledWith(db, 'b1');
    }
  });

  it('«Підтвердити всіх» spends for every booking', async () => {
    const entitlements = { syncSpend: jest.fn() };
    const { db } = makeDb([
      [{ id: 'slot-1', trainerId: TRAINER }],
      [
        { id: 'b1', memberId: 'm1' },
        { id: 'b2', memberId: 'm2' },
      ],
    ]);
    await makeService(db, entitlements).markAllAttendance('slot-1', TRAINER);
    expect(entitlements.syncSpend.mock.calls.map((c: unknown[]) => c[1])).toEqual(['b1', 'b2']);
  });

  // Packages are locked member by member; the same order everywhere means two batches (this and the 22:00
  // cron) wait for each other instead of deadlocking and rolling back the whole batch
  it('«Підтвердити всіх» marks members in a fixed order (by member id)', async () => {
    const entitlements = { syncSpend: jest.fn() };
    const { db } = makeDb([
      [{ id: 'slot-1', trainerId: TRAINER }],
      [
        { id: 'b1', memberId: 'm-c' },
        { id: 'b2', memberId: 'm-a' },
        { id: 'b3', memberId: 'm-b' },
      ],
    ]);
    await makeService(db, entitlements).markAllAttendance('slot-1', TRAINER);
    expect(entitlements.syncSpend.mock.calls.map((c: unknown[]) => c[1])).toEqual(['b2', 'b3', 'b1']);
  });
});

describe('Group slots — upsertGroupSlot', () => {
  it('any time from 06:00 to 21:00 in 15-minute steps (no longer only 19:00 / 20:00)', async () => {
    const { db, values } = makeDb([[]]);
    await makeService(db).upsertGroupSlot(TRAINER, '2026-10-21', '18:00');
    expect(values).toContainEqual(expect.objectContaining({ slotTime: '18:00', trainingType: 'групові', capacity: 8 }));
    await expect(makeService(makeDb().db).upsertGroupSlot(TRAINER, '2026-10-21', '05:45')).rejects.toThrow(
      new BadRequestException('Group trainings are from 06:00 to 21:00'),
    );
  });

  it('not at a time that has already passed (the clock is 2026-10-20 12:00 here)', async () => {
    await expect(makeService(makeDb([[]]).db).upsertGroupSlot(TRAINER, '2026-10-20', '10:00')).rejects.toThrow(
      new BadRequestException('Training time is in the past'),
    );
  });

  it("at least an hour from the trainer's other active group training that day", async () => {
    const { db } = makeDb([[{ slotTime: '19:00' }]]);
    await expect(makeService(db).upsertGroupSlot(TRAINER, '2026-10-21', '19:30')).rejects.toThrow(
      new BadRequestException('Group trainings must be at least an hour apart'),
    );
  });

  it('does not take over an active assigned training at that time', async () => {
    let call = 0;
    const { db } = makeDb([], () => (call++ === 0 ? [{ id: 'day-1' }] : []));
    await expect(makeService(db).upsertGroupSlot(TRAINER, '2026-10-21', '19:00')).rejects.toThrow(ConflictException);
  });
});

describe('Training day SCHEDULED — the trainer schedule of that weekday', () => {
  it("adds the trainer's own times for that weekday (Wed here), not 19:00 / 20:00", async () => {
    mockLoadSchedule.mockResolvedValue({
      bookingOpensAt: '08:00',
      autoCreate: true,
      times: [
        { weekday: 1, slotTime: '10:00' },
        { weekday: 3, slotTime: '18:00' },
      ],
    });
    const { db, values } = makeDb();
    await makeService(db).upsertTrainingDay(TRAINER, '2026-10-21', { status: 'SCHEDULED' } as any);
    expect(values).toContainEqual([
      expect.objectContaining({ slotTime: '18:00', trainingType: 'групові', trainerId: TRAINER }),
    ]);
  });
});

describe('Training day SCHEDULED — no overlap with what is already there', () => {
  it('leaves out a schedule time within an hour of an active group training that day', async () => {
    mockLoadSchedule.mockResolvedValue({
      bookingOpensAt: '08:00',
      autoCreate: true,
      times: [
        { weekday: 3, slotTime: '10:00' },
        { weekday: 3, slotTime: '19:30' },
      ],
    });
    const { db, values } = makeDb([[{ slotTime: '19:00' }]]);
    await makeService(db).upsertTrainingDay(TRAINER, '2026-10-21', { status: 'SCHEDULED' } as any);
    expect(values).toContainEqual([expect.objectContaining({ slotTime: '10:00' })]);
  });
});

describe('Calendar — assigned slot members', () => {
  it('returns assigned members with booking and trainings left (of that type) for assigned slots only', async () => {
    const rows = [
      {
        localDate: '2026-10-21',
        slotId: 'g1',
        slotTime: '19:00',
        trainingType: 'групові',
        bookedCount: 3,
        capacity: 8,
        trainerId: TRAINER,
      },
      {
        localDate: '2026-10-21',
        slotId: 'p1',
        slotTime: '10:30',
        trainingType: 'спліт',
        bookedCount: 0,
        capacity: 2,
        trainerId: TRAINER,
      },
    ];
    const { db } = makeDb([
      rows,
      [
        { slotId: 'p1', id: M1, displayName: 'Катя' },
        { slotId: 'p1', id: M2, displayName: 'Оля' },
        { slotId: 'p1', id: M3, displayName: 'Іра' },
      ],
      [
        { slotId: 'p1', memberId: M1, spentFrom: null },
        { slotId: 'p1', memberId: M2, spentFrom: 'pkg-2' },
      ],
    ]);
    const summaries = new Map([
      [M1, { clubCard: null, packagesLeft: [{ trainingType: 'спліт', left: 5 }] }],
      [M2, { clubCard: null, packagesLeft: [{ trainingType: 'персональні', left: 2 }] }],
    ]);
    const entitlements = { summaries: jest.fn().mockResolvedValue(summaries) };
    const result = await makeService(db, entitlements).getCalendar(TRAINER, '2026-10');
    expect(result.find((s) => s.slotId === 'g1')?.members).toEqual([]);
    // Оля's training was already spent from a package (now empty): paid all the same. Іра cancelled
    expect(result.find((s) => s.slotId === 'p1')?.members).toEqual([
      { id: M1, displayName: 'Катя', booked: true, spent: false, packageLeft: 5 },
      { id: M2, displayName: 'Оля', booked: true, spent: true, packageLeft: 0 },
      { id: M3, displayName: 'Іра', booked: false, spent: false, packageLeft: 0 },
    ]);
  });
});

describe('Cancellation reasons for the trainer', () => {
  const rows = [
    {
      bookingId: 'b1',
      slotId: 's1',
      memberId: M1,
      displayName: 'Оля',
      reason: 'Захворіла',
      cancelledAt: new Date('2026-10-22T14:42:00Z'),
      slotTime: '19:00',
      localDate: '2026-10-22',
      switchedToSlotId: null,
      switchedToTime: null,
    },
    {
      bookingId: 'b2',
      slotId: 's1',
      memberId: M2,
      displayName: 'Іра',
      reason: 'Не встигаю',
      cancelledAt: new Date('2026-10-22T13:10:00Z'),
      slotTime: '19:00',
      localDate: '2026-10-22',
      switchedToSlotId: 's2',
      switchedToTime: '20:00',
    },
  ];

  it('calendar modal: cancelled and moved, with reason and time', async () => {
    // the slot, who is booked on it now (nobody), then the cancellations
    const { db } = makeDb([[{ id: 's1', trainerId: TRAINER }], [], rows]);
    await expect(makeService(db).getSlotCancellations(TRAINER, 's1')).resolves.toEqual([
      {
        bookingId: 'b1',
        displayName: 'Оля',
        reason: 'Захворіла',
        cancelledAt: '2026-10-22T14:42:00.000Z',
        switchedToTime: null,
      },
      {
        bookingId: 'b2',
        displayName: 'Іра',
        reason: 'Не встигаю',
        cancelledAt: '2026-10-22T13:10:00.000Z',
        switchedToTime: '20:00',
      },
    ]);
  });

  it('client history: adds the training date and time', async () => {
    // visibility check (own or unassigned client), then the history
    const { db } = makeDb([[{ id: M1 }], [rows[0]]]);
    const [entry] = await makeService(db).getMemberCancellations('trainer-1', M1);
    expect(entry).toEqual(expect.objectContaining({ localDate: '2026-10-22', slotTime: '19:00', reason: 'Захворіла' }));
  });
});

describe('Clients per trainer', () => {
  it("hides history of another trainer's client (404)", async () => {
    const { db } = makeDb([[]]);
    await expect(makeService(db).getMemberCancellations('trainer-1', M1)).rejects.toThrow(NotFoundException);
  });

  it('a trainer sees own and unassigned clients only', () => {
    const { db } = makeDb();
    const where = (makeService(db) as any).visibleTo('trainer-1');
    const { sql, params } = new PgDialect().sqlToQuery(where);
    expect(sql).toBe('("members"."trainer_id" = $1 or "members"."trainer_id" is null)');
    expect(params).toEqual(['trainer-1']);
  });

  it('reassigns a client to another trainer', async () => {
    const { db, sets } = makeDb([[{ id: 'trainer-2' }]], () => [{ id: M1, trainerId: 'trainer-2' }]);
    await expect(makeService(db).assignTrainer('trainer-1', M1, 'trainer-2')).resolves.toEqual({
      id: M1,
      trainerId: 'trainer-2',
    });
    expect(sets).toEqual([{ trainerId: 'trainer-2' }]);
  });

  it('refuses an unknown trainer', async () => {
    const { db } = makeDb([[]]);
    await expect(makeService(db).assignTrainer('trainer-1', M1, 'nobody')).rejects.toThrow('Trainer not found');
    expect(db.update).not.toHaveBeenCalled();
  });

  it("cannot reassign another trainer's client (update matches nothing → 404)", async () => {
    const { db } = makeDb([[{ id: 'trainer-2' }]], () => []);
    await expect(makeService(db).assignTrainer('trainer-1', M1, 'trainer-2')).rejects.toThrow('Member not found');
  });

  it('trainer picker returns usernames only', async () => {
    const { db } = makeDb([[{ id: 'trainer-1', username: 'ilona' }]]);
    await expect(makeService(db).getTrainers()).resolves.toEqual([{ id: 'trainer-1', username: 'ilona' }]);
    expect(db.select).toHaveBeenCalledWith({ id: expect.anything(), username: expect.anything() });
  });
});

describe('History of past trainings', () => {
  const day = (n: number) => ({
    id: `day-${n}`,
    localDate: `2026-10-${String(n).padStart(2, '0')}`,
    status: 'SCHEDULED',
  });
  const slot = {
    id: 's1',
    trainingDayId: 'day-20',
    slotTime: '19:00',
    status: 'ACTIVE',
    trainingType: 'групові',
    capacity: 8,
    bookedCount: 2,
    trainerId: TRAINER,
  };

  it('groups slots under their day with participants, attendance and cancellations', async () => {
    const { db } = makeDb([
      [day(20)],
      [slot],
      [
        { bookingId: 'b1', slotId: 's1', memberId: M1, displayName: 'Катя', attendanceStatus: 'PRESENT' },
        { bookingId: 'b2', slotId: 's1', memberId: M2, displayName: 'Ліза', attendanceStatus: null },
      ],
      [
        {
          bookingId: 'b3',
          slotId: 's1',
          memberId: M3,
          displayName: 'Оля',
          reason: 'Захворіла',
          cancelledAt: new Date('2026-10-20T14:00:00Z'),
          slotTime: '19:00',
          localDate: '2026-10-20',
          switchedToSlotId: null,
          switchedToTime: null,
        },
      ],
    ]);
    const { days, nextBefore } = await makeService(db).getHistory(TRAINER);
    expect(nextBefore).toBeNull();
    expect(days).toHaveLength(1);
    expect(days[0].slots[0].participants.map((p) => p.attendanceStatus)).toEqual(['PRESENT', 'UNMARKED']);
    expect(days[0].slots[0].cancellations).toEqual([
      expect.objectContaining({ displayName: 'Оля', reason: 'Захворіла' }),
    ]);
  });

  it('a member back on the training (moved away and returned) is not listed under «Скасували»', async () => {
    const { db } = makeDb([
      [day(20)],
      [slot],
      [{ bookingId: 'b5', slotId: 's1', memberId: M1, displayName: 'Катерина', attendanceStatus: null }],
      [
        {
          bookingId: 'b4',
          slotId: 's1',
          memberId: M1,
          displayName: 'Катерина',
          reason: 'Хочу раніше',
          cancelledAt: new Date('2026-10-20T16:06:00Z'),
          slotTime: '20:00',
          localDate: '2026-10-20',
          switchedToSlotId: 's0',
          switchedToTime: '19:00',
        },
      ],
    ]);
    const { days } = await makeService(db).getHistory(TRAINER);
    expect(days[0].slots[0].cancellations).toEqual([]);
    expect(days[0].slots[0].participants).toHaveLength(1);
  });

  it('returns a cursor when there are older days than one page', async () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => day(20 - i));
    const { db } = makeDb([fifteen, []]);
    const { days, nextBefore } = await makeService(db).getHistory(TRAINER);
    expect(days).toHaveLength(14);
    expect(nextBefore).toBe('2026-10-07'); // the oldest day on this page
  });

  it('never shows today or future days, even with a later cursor', async () => {
    const { db } = makeDb([[]]);
    const where = jest.fn(() => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }));
    db.select = jest.fn(() => ({ from: () => ({ where }) }));
    await makeService(db).getHistory(TRAINER, '2026-12-31');
    const cond = new PgDialect().sqlToQuery((where.mock.calls[0] as unknown[])[0] as any);
    expect(cond.params).toContain('2026-10-20'); // today in the test clock, not the cursor
  });
});

describe('Calendar «Скасували»', () => {
  it('leaves out members who are booked on the training again', async () => {
    const mine = { id: 's1', trainerId: TRAINER, status: 'ACTIVE' };
    const { db } = makeDb([
      [mine],
      [{ memberId: M1 }],
      [
        {
          bookingId: 'b4',
          slotId: 's1',
          memberId: M1,
          displayName: 'Катерина',
          reason: 'Хочу раніше',
          cancelledAt: new Date(),
          switchedToSlotId: 's0',
          switchedToTime: '19:00',
        },
        {
          bookingId: 'b6',
          slotId: 's1',
          memberId: M2,
          displayName: 'Оля',
          reason: 'Захворіла',
          cancelledAt: new Date(),
          switchedToSlotId: null,
          switchedToTime: null,
        },
      ],
    ]);
    const list = await makeService(db).getSlotCancellations(TRAINER, 's1');
    expect(list.map((c) => c.displayName)).toEqual(['Оля']);
  });
});

describe('Cancelling a training gives the trainings back', () => {
  const mySlot = {
    id: 's1',
    trainingDayId: 'day-1',
    slotTime: '18:00',
    status: 'ACTIVE',
    trainingType: 'персональні',
    trainerId: TRAINER,
  };
  const notifications = { enqueueAndProcess: jest.fn().mockResolvedValue(undefined) };

  it('cancelling one training removes its marks and spends (a ✓ or ✗ no longer costs a training)', async () => {
    const { db } = makeDb([[mySlot], [{ memberId: M1 }], [{ localDate: '2026-10-20' }], [mySlot]]);
    const svc = new AdminScheduleService({ db } as any, notifications as any, { now: () => now }, {
      syncSpend: jest.fn(),
    } as any);
    await svc.updateSlot(TRAINER, 's1', { status: 'CANCELLED' });
    const deleted = db.delete.mock.calls.map((c: unknown[]) => c[0]);
    expect(deleted).toEqual(expect.arrayContaining([packageSpends, attendance]));
  });

  it('«Скасувати мої тренування цього дня» does the same for every cancelled training', async () => {
    const { db } = makeDb([[{ id: 'day-1', localDate: '2026-10-25' }], [{ id: 's1', slotTime: '18:00' }], []]);
    const svc = new AdminScheduleService({ db } as any, notifications as any, { now: () => now }, {
      syncSpend: jest.fn(),
    } as any);
    await svc.upsertTrainingDay(TRAINER, '2026-10-25', { status: 'CANCELLED' } as any);
    const deleted = db.delete.mock.calls.map((c: unknown[]) => c[0]);
    expect(deleted).toEqual(expect.arrayContaining([packageSpends, attendance]));
  });
});

describe('Each trainer sees and changes only own trainings', () => {
  const otherSlot = {
    id: 's9',
    trainingDayId: 'day-1',
    slotTime: '19:00',
    status: 'ACTIVE',
    trainingType: 'групові',
    trainerId: 'trainer-2',
  };

  it("cancelling another trainer's slot answers 404", async () => {
    const { db } = makeDb([[otherSlot]]);
    await expect(makeService(db).updateSlot(TRAINER, 's9', { status: 'CANCELLED' })).rejects.toThrow(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("marking attendance on another trainer's training answers 404", async () => {
    const { db } = makeDb([[]]); // booking joined with a slot of this trainer: nothing
    await expect(makeService(db).updateBookingAttendance('b1', { status: 'PRESENT' }, TRAINER)).rejects.toThrow(
      NotFoundException,
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("cannot put another trainer's client on a training (404)", async () => {
    const { db } = makeDb([[]]); // visibleTo(trainer) finds nobody
    await expect(
      makeService(db).createAssignedSlot(TRAINER, '2026-10-21', {
        slotTime: '10:30',
        trainingType: 'персональні',
        memberIds: [M1],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("history and the today page look only at days with this trainer's slots", () => {
    const { db } = makeDb();
    const cond = new PgDialect().sqlToQuery((makeService(db) as any).hasSlotsOf(TRAINER));
    expect(cond.sql).toContain('ts.trainer_id = $1');
    expect(cond.params).toEqual([TRAINER]);
  });
});

describe("Trainer's today page — the booking window of the trainer's own schedule", () => {
  it('opens at the trainer time, closes when the last group training starts; the day stays until midnight', async () => {
    mockLoadSchedule.mockResolvedValue({ bookingOpensAt: '08:00', autoCreate: true, times: [] });
    const day = { id: 'day-1', localDate: '2026-10-20', status: 'SCHEDULED' };
    const own = [
      { id: 'g', slotTime: '10:00', trainingType: 'групові', status: 'ACTIVE', capacity: 8, bookedCount: 0 },
      { id: 'p', slotTime: '18:00', trainingType: 'персональні', status: 'ACTIVE', capacity: 1, bookedCount: 1 },
    ];
    const { db } = makeDb([[day], own]);
    const result = await makeService(db).getSchedule(TRAINER); // 12:00: the 10:00 group is over, 18:00 ahead
    expect(mockLoadSchedule).toHaveBeenCalledWith(db, TRAINER);
    expect(result).toMatchObject({
      localDate: '2026-10-20',
      bookingWindowOpen: false,
      bookingOpenAt: '2026-10-20T05:00:00.000Z', // 08:00 Kyiv (UTC+3)
      bookingCloseAt: '2026-10-20T07:00:00.000Z', // 10:00 Kyiv
    });
  });
});
