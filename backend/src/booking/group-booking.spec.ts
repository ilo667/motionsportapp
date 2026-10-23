import { DateTime } from 'luxon';
import { tryBookGroup } from './group-booking';
import { vacancyAlerts } from '../database/schema';

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

  it('a full slot: FULL, nothing inserted', async () => {
    const { tx, inserts } = makeTx([MEMBER, [{ ...slot, bookedCount: 8 }], TRAINER, []]);
    expect(await tryBookGroup(tx, at(15), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'FULL' });
    expect(inserts).toEqual([]);
  });

  it('already booked on a group training that day: ALREADY_BOOKED', async () => {
    const { tx } = makeTx([MEMBER, [slot], TRAINER, [{ id: 'b0', slotId: 'slot-2' }]]);
    expect(await tryBookGroup(tx, at(15), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'ALREADY_BOOKED' });
  });

  it('outside 14:00–21:00: WINDOW', async () => {
    const { tx } = makeTx([MEMBER, [slot], TRAINER, []]);
    expect(await tryBookGroup(tx, at(21), 'member-1', 'slot-1')).toEqual({ ok: false, reason: 'WINDOW' });
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
