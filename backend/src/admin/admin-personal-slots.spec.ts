import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DateTime } from 'luxon';
import { AdminScheduleService } from './admin-schedule.service';
import { CreatePersonalSlotDto } from './dto/create-personal-slot.dto';

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
    for (const m of ['from', 'innerJoin', 'where', 'for', 'orderBy', 'limit']) chain[m] = jest.fn(() => readLink());
    return chain;
  }
  function writeLink(): any {
    const chain: any = { then: (r: (v: unknown) => void) => r(writeResult()) };
    for (const m of ['where', 'onConflictDoUpdate', 'onConflictDoNothing', 'returning']) chain[m] = jest.fn(() => writeLink());
    chain.values = jest.fn((v: unknown) => { values.push(v); return writeLink(); });
    chain.set = jest.fn((v: Record<string, unknown>) => { sets.push(v); return writeLink(); });
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

const now = DateTime.fromObject({ year: 2026, month: 10, day: 20, hour: 12 }, { zone: 'Europe/Kyiv' });

function makeService(db: any) {
  return new AdminScheduleService({ db } as any, {} as any, { getNow: jest.fn().mockResolvedValue(now) } as any);
}

async function errorsOf(cls: any, body: object) {
  return validate(plainToInstance(cls, body) as object);
}

describe('Personal slots — DTO validation', () => {
  const valid = { slotTime: '18:15', trainingType: 'спліт', memberIds: [M1, M2] };

  it('accepts any time in 15-minute steps', async () => {
    expect(await errorsOf(CreatePersonalSlotDto, valid)).toHaveLength(0);
    expect(await errorsOf(CreatePersonalSlotDto, { ...valid, slotTime: '07:45' })).toHaveLength(0);
  });

  it('rejects other minutes and malformed times', async () => {
    expect(await errorsOf(CreatePersonalSlotDto, { ...valid, slotTime: '18:10' })).not.toHaveLength(0);
    expect(await errorsOf(CreatePersonalSlotDto, { ...valid, slotTime: '24:00' })).not.toHaveLength(0);
  });

  it('rejects групові as a personal slot type', async () => {
    expect(await errorsOf(CreatePersonalSlotDto, { ...valid, trainingType: 'групові' })).not.toHaveLength(0);
  });

  it('requires 1 to 3 distinct members', async () => {
    expect(await errorsOf(CreatePersonalSlotDto, { ...valid, memberIds: [] })).not.toHaveLength(0);
    expect(await errorsOf(CreatePersonalSlotDto, { ...valid, memberIds: [M1, M2, M3, M4] })).not.toHaveLength(0);
    expect(await errorsOf(CreatePersonalSlotDto, { ...valid, memberIds: [M1, M1] })).not.toHaveLength(0);
  });
});

describe('Personal slots — createPersonalSlot', () => {
  it('creates a split for 2 members: capacity 3 and one slot_members row each', async () => {
    const { db, values } = makeDb([[{ id: M1 }, { id: M2 }]]);
    const result = await makeService(db).createPersonalSlot('2026-10-21', { slotTime: '10:30', trainingType: 'спліт', memberIds: [M1, M2] });

    expect(result).toEqual({ ok: true, slotId: 'slot-new' });
    expect(values).toContainEqual(expect.objectContaining({ slotTime: '10:30', trainingType: 'спліт', capacity: 3 }));
    expect(values).toContainEqual([{ slotId: 'slot-new', memberId: M1 }, { slotId: 'slot-new', memberId: M2 }]);
  });

  it('allows exactly one member for an individual training', async () => {
    const { db } = makeDb([[{ id: M1 }, { id: M2 }]]);
    await expect(
      makeService(db).createPersonalSlot('2026-10-21', { slotTime: '10:30', trainingType: 'індивідуальні', memberIds: [M1, M2] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFound when a member does not exist', async () => {
    const { db } = makeDb([[{ id: M1 }]]);
    await expect(
      makeService(db).createPersonalSlot('2026-10-21', { slotTime: '10:30', trainingType: 'спліт', memberIds: [M1, M2] }),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses a time that has already passed', async () => {
    const { db } = makeDb([[{ id: M1 }]]);
    await expect(
      makeService(db).createPersonalSlot('2026-10-20', { slotTime: '11:45', trainingType: 'індивідуальні', memberIds: [M1] }),
    ).rejects.toThrow('in the past');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns 409 when another active training is at that time (nothing re-used)', async () => {
    // ensureDay returns the day, the slot upsert's WHERE status = CANCELLED matches nothing
    let call = 0;
    const { db } = makeDb([[{ id: M1 }]], () => (call++ === 0 ? [{ id: 'day-1' }] : []));
    await expect(
      makeService(db).createPersonalSlot('2026-10-21', { slotTime: '19:00', trainingType: 'індивідуальні', memberIds: [M1] }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('Personal slots — updateSlotMembers', () => {
  const split = { id: 'slot-1', trainingType: 'спліт', status: 'ACTIVE' };

  it('cannot remove a member who already booked the training', async () => {
    const { db } = makeDb([[split], [{ id: M2 }, { id: M3 }], [{ memberId: M1 }]]);
    await expect(makeService(db).updateSlotMembers('slot-1', [M2, M3])).rejects.toThrow('already booked');
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('replaces members without changing capacity', async () => {
    const { db, values, sets } = makeDb([[split], [{ id: M1 }, { id: M2 }, { id: M3 }], [{ memberId: M1 }]]);
    await makeService(db).updateSlotMembers('slot-1', [M1, M2, M3]);
    expect(values).toContainEqual([M1, M2, M3].map((memberId) => ({ slotId: 'slot-1', memberId })));
    expect(sets).not.toContainEqual(expect.objectContaining({ capacity: expect.anything() }));
  });

  it('refuses group slots (open to everyone)', async () => {
    const { db } = makeDb([[{ ...split, trainingType: 'групові' }]]);
    await expect(makeService(db).updateSlotMembers('slot-1', [M1])).rejects.toThrow(BadRequestException);
  });
});

describe('Group slots — upsertGroupSlot', () => {
  it('only at 19:00 and 20:00', async () => {
    const { db } = makeDb();
    await expect(makeService(db).upsertGroupSlot('2026-10-21', '18:00')).rejects.toThrow(BadRequestException);
  });

  it('does not take over an active personal training at that time', async () => {
    let call = 0;
    const { db } = makeDb([], () => (call++ === 0 ? [{ id: 'day-1' }] : []));
    await expect(makeService(db).upsertGroupSlot('2026-10-21', '19:00')).rejects.toThrow(ConflictException);
  });
});

describe('Calendar — personal slot members', () => {
  it('returns assigned members with their payment state for personal slots only', async () => {
    const rows = [
      { localDate: '2026-10-21', slotId: 'g1', slotTime: '19:00', trainingType: 'групові', bookedCount: 3, capacity: 8 },
      { localDate: '2026-10-21', slotId: 'p1', slotTime: '10:30', trainingType: 'спліт', bookedCount: 0, capacity: 2 },
    ];
    const { db } = makeDb([
      rows,
      [{ slotId: 'p1', id: M1, displayName: 'Катя' }, { slotId: 'p1', id: M2, displayName: 'Оля' }, { slotId: 'p1', id: M3, displayName: 'Іра' }],
      [{ slotId: 'p1', memberId: M1, paymentStatus: 'PAID' }, { slotId: 'p1', memberId: M2, paymentStatus: 'PENDING' }],
    ]);
    const result = await makeService(db).getCalendar('2026-10');
    expect(result.find((s) => s.slotId === 'g1')?.members).toEqual([]);
    expect(result.find((s) => s.slotId === 'p1')?.members).toEqual([
      { id: M1, displayName: 'Катя', paymentStatus: 'PAID' },
      { id: M2, displayName: 'Оля', paymentStatus: 'PENDING' },
      { id: M3, displayName: 'Іра', paymentStatus: null },
    ]);
  });
});
