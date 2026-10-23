import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { EntitlementsService } from './entitlements.service';
import { clubCards, packages, packageSpends, purchases } from '../database/schema';
import { KY_ZONE } from '../schedule/training-types';
import { tryBookGroup } from '../booking/group-booking';

jest.mock('../booking/group-booking', () => ({ tryBookGroup: jest.fn() }));
const mockTryBook = tryBookGroup as jest.Mock;
beforeEach(() => mockTryBook.mockReset());

const NOW = DateTime.fromISO('2026-10-23T12:00:00', { zone: KY_ZONE });

// Drizzle chain mock: each awaited query takes the next result from `results`.
// Inserts and deletes are recorded with the table they hit
function makeDb(results: unknown[][]) {
  const queue = [...results];
  const inserts: { table: unknown; values: unknown }[] = [];
  const deletes: unknown[] = [];
  const updates: { table: unknown; set: unknown }[] = [];
  let selects = 0;
  function link(onValues?: (v: unknown) => void): any {
    const chain: any = {
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve(queue.shift() ?? []).then(resolve, reject),
    };
    for (const m of [
      'from',
      'where',
      'orderBy',
      'limit',
      'innerJoin',
      'leftJoin',
      'for',
      'groupBy',
      'onConflictDoNothing',
      'returning',
    ]) {
      chain[m] = jest.fn(() => chain);
    }
    chain.values = jest.fn((v: unknown) => {
      onValues?.(v);
      return chain;
    });
    return chain;
  }
  const db: any = {
    select: jest.fn(() => {
      selects++;
      return link();
    }),
    insert: jest.fn((table: unknown) => link((values) => inserts.push({ table, values }))),
    delete: jest.fn((table: unknown) => {
      deletes.push(table);
      return link();
    }),
    update: jest.fn((table: unknown) => {
      const chain = link();
      chain.set = jest.fn((set: unknown) => {
        updates.push({ table, set });
        return chain;
      });
      return chain;
    }),
  };
  return { db, inserts, deletes, updates, selects: () => selects };
}

function makeService(db: any) {
  return new EntitlementsService({ db } as any, { now: () => NOW });
}

const line = (over: Record<string, unknown>) => ({
  id: 'line-1',
  memberId: 'm1',
  title: 'Повний день',
  optionLabel: '3 місяці',
  section: 'club_card',
  durationMonths: 3,
  trainingType: null,
  trainingCount: null,
  ...over,
});

// The purchase was made on 2026-10-23 (Kyiv)
const BOUGHT = new Date('2026-10-23T09:00:00Z');

describe('Entitlements — buying', () => {
  it('a paid club card waits for activation: no dates, a month from the purchase day to activate it', async () => {
    const { db, inserts } = makeDb([[line({ createdAt: BOUGHT })]]);
    await makeService(db).activate(db, 'p1');
    expect(inserts).toEqual([
      {
        table: clubCards,
        values: {
          memberId: 'm1',
          purchaseItemId: 'line-1',
          label: 'Повний день · 3 місяці',
          validFrom: null,
          validUntil: null,
          durationMonths: 3,
          activateBy: '2026-11-23',
        },
      },
    ]);
  });

  it('a trainer service becomes a package that is not activated yet', async () => {
    const { db, inserts } = makeDb([
      [
        line({
          id: 'line-2',
          title: 'Персональне',
          optionLabel: '8 тренувань',
          section: 'assigned',
          durationMonths: 1,
          trainingType: 'персональні',
          trainingCount: 8,
          createdAt: BOUGHT,
        }),
      ],
    ]);
    await makeService(db).activate(db, 'p1');
    expect(inserts).toEqual([
      {
        table: packages,
        values: {
          memberId: 'm1',
          purchaseItemId: 'line-2',
          trainingType: 'персональні',
          total: 8,
          durationMonths: 1,
          purchasedOn: '2026-10-23',
          activateBy: '2026-11-23',
        },
      },
    ]);
  });

  it('a group pass is a package of type групові', async () => {
    const { db, inserts } = makeDb([
      [
        line({
          section: 'group',
          title: 'Абонемент',
          optionLabel: '10 занять',
          durationMonths: 1,
          trainingType: 'групові',
          trainingCount: 10,
          createdAt: BOUGHT,
        }),
      ],
    ]);
    await makeService(db).activate(db, 'p1');
    expect(inserts[0]).toMatchObject({
      table: packages,
      values: { trainingType: 'групові', total: 10, purchasedOn: '2026-10-23', activateBy: '2026-11-23' },
    });
  });
});

describe('Entitlements — group pass bought from «Записатися»', () => {
  const groupLine = line({
    section: 'group',
    title: 'Разове відвідування',
    optionLabel: null,
    durationMonths: 1,
    trainingType: 'групові',
    trainingCount: 1,
    createdAt: BOUGHT,
  });

  // Reads: the lines, the package insert (the mock's writes take a result too), the purchase
  it('once paid, books the remembered slot and keeps the booking on the purchase', async () => {
    mockTryBook.mockResolvedValueOnce({ ok: true, bookingId: 'b1' });
    const { db, updates } = makeDb([[groupLine], [], [{ memberId: 'm1', slotId: 'slot-1', bookingId: null }]]);
    const svc = makeService(db);
    const spend = jest.spyOn(svc, 'syncSpend').mockResolvedValue(undefined);
    await svc.activate(db, 'p1');
    expect(mockTryBook).toHaveBeenCalledWith(db, NOW, 'm1', 'slot-1');
    expect(updates).toEqual([{ table: purchases, set: { bookingId: 'b1' } }]);
    expect(spend).toHaveBeenCalledWith(db, 'b1');
  });

  it('cannot book any more (window closed, slot full): the pass stays, nothing throws', async () => {
    mockTryBook.mockResolvedValueOnce({ ok: false, reason: 'WINDOW' });
    const { db, inserts, updates } = makeDb([[groupLine], [], [{ memberId: 'm1', slotId: 'slot-1', bookingId: null }]]);
    const svc = makeService(db);
    const spend = jest.spyOn(svc, 'syncSpend').mockResolvedValue(undefined);
    await expect(svc.activate(db, 'p1')).resolves.toBeUndefined();
    expect(inserts).toHaveLength(1);
    expect(updates).toEqual([]);
    expect(spend).not.toHaveBeenCalled();
  });

  it('cash confirmed after the mark: the training is spent from this pass right away', async () => {
    const { db } = makeDb([[groupLine], [], [{ memberId: 'm1', slotId: 'slot-1', bookingId: 'b1' }]]);
    const svc = makeService(db);
    const spend = jest.spyOn(svc, 'syncSpend').mockResolvedValue(undefined);
    await svc.activate(db, 'p1');
    expect(mockTryBook).not.toHaveBeenCalled();
    expect(spend).toHaveBeenCalledWith(db, 'b1');
  });
});

describe('Entitlements — spends', () => {
  const booking = (over: Record<string, unknown>) => ({
    memberId: 'm1',
    trainingType: 'персональні',
    localDate: '2026-10-25',
    marked: 'b1',
    spentFrom: null,
    ...over,
  });
  const pack = (over: Record<string, unknown>) => ({
    id: 'p',
    total: 8,
    durationMonths: 1,
    purchasedOn: '2026-10-23',
    activateBy: '2026-11-23',
    activatedOn: null,
    validUntil: null,
    forBooking: false,
    ...over,
  });

  // Reads: the booking, then the member's packages of that type locked (no counts: a count in the locking
  // statement would use a snapshot from before the lock wait), then the spends counted in a fresh statement
  it('a mark spends from the oldest usable package that has trainings left', async () => {
    const { db, inserts } = makeDb([
      [booking({})],
      [pack({ id: 'old', total: 1, activatedOn: '2026-10-23', validUntil: '2026-11-23' }), pack({ id: 'new' })],
      [{ packageId: 'old', used: 1 }],
    ]);
    await makeService(db).syncSpend(db, 'b1');
    expect(inserts).toEqual([{ table: packageSpends, values: { bookingId: 'b1', packageId: 'new' } }]);
  });

  it('the first mark activates the package from the training date', async () => {
    const { db, updates } = makeDb([[booking({})], [pack({})], []]);
    await makeService(db).syncSpend(db, 'b1');
    expect(updates).toEqual([{ table: packages, set: { activatedOn: '2026-10-25', validUntil: '2026-11-25' } }]);
  });

  it('a package already activated is not activated again', async () => {
    const { db, inserts, updates } = makeDb([
      [booking({})],
      [pack({ activatedOn: '2026-10-24', validUntil: '2026-11-24' })],
      [{ packageId: 'p', used: 1 }],
    ]);
    await makeService(db).syncSpend(db, 'b1');
    expect(inserts).toHaveLength(1);
    expect(updates).toEqual([]);
  });

  it('a training dated before the purchase is not paid by that package', async () => {
    const { db, inserts } = makeDb([[booking({ localDate: '2026-10-20' })], [pack({})], []]);
    await makeService(db).syncSpend(db, 'b1');
    expect(inserts).toEqual([]);
  });

  it('a burned package pays nothing', async () => {
    const { db, inserts } = makeDb([[booking({ localDate: '2026-11-24' })], [pack({})], []]);
    await makeService(db).syncSpend(db, 'b1');
    expect(inserts).toEqual([]);
  });

  it('an expired package pays nothing', async () => {
    const { db, inserts } = makeDb([
      [booking({ localDate: '2026-12-02' })],
      [pack({ activatedOn: '2026-11-01', validUntil: '2026-12-01' })],
      [],
    ]);
    await makeService(db).syncSpend(db, 'b1');
    expect(inserts).toEqual([]);
  });

  it('a group training spends from a group pass', async () => {
    const { db, inserts } = makeDb([[booking({ trainingType: 'групові' })], [pack({ total: 10 })], []]);
    await makeService(db).syncSpend(db, 'b1');
    expect(inserts).toEqual([{ table: packageSpends, values: { bookingId: 'b1', packageId: 'p' } }]);
  });

  it('the pass bought for this booking pays first, even when an older one has trainings left', async () => {
    const { db, inserts } = makeDb([
      [booking({ trainingType: 'групові' })],
      [pack({ id: 'older', total: 10 }), pack({ id: 'bought-for-it', total: 1, forBooking: true })],
      [],
    ]);
    await makeService(db).syncSpend(db, 'b1');
    expect(inserts).toEqual([{ table: packageSpends, values: { bookingId: 'b1', packageId: 'bought-for-it' } }]);
  });

  it('counts spends only after the lock, in its own statement (two marks at once cannot both take the last one)', async () => {
    const { db, inserts, selects } = makeDb([[booking({})], [pack({ total: 1 })], [{ packageId: 'p', used: 1 }]]);
    await makeService(db).syncSpend(db, 'b1');
    expect(selects()).toBe(3);
    expect(inserts).toEqual([]);
  });

  it('changing ✓ to ✗ keeps the single spend', async () => {
    const { db, inserts, deletes } = makeDb([[booking({ spentFrom: 'p' })]]);
    await makeService(db).syncSpend(db, 'b1');
    expect(inserts).toEqual([]);
    expect(deletes).toEqual([]);
  });

  it('«—» gives the training back and keeps the activation', async () => {
    const { db, deletes, updates } = makeDb([[booking({ marked: null, spentFrom: 'p' })]]);
    await makeService(db).syncSpend(db, 'b1');
    expect(deletes).toEqual([packageSpends]);
    expect(updates).toEqual([]);
  });

  it('no package left: the mark stays, nothing is spent', async () => {
    const { db, inserts } = makeDb([[booking({})], [pack({ total: 1 })], [{ packageId: 'p', used: 1 }]]);
    await expect(makeService(db).syncSpend(db, 'b1')).resolves.toBeUndefined();
    expect(inserts).toEqual([]);
  });
});

describe('Entitlements — club card activation', () => {
  it('the trainer activates a waiting card from today for its months', async () => {
    const { db, updates } = makeDb([[{ id: 'c1' }]]);
    await makeService(db).activateCard(db, 'm1', 'c1');
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(clubCards);
    // valid_until is computed in SQL from duration_months; valid_from is today
    expect(updates[0].set).toMatchObject({ validFrom: '2026-10-23' });
  });

  it('409 for a card that is burned or already active', async () => {
    const { db } = makeDb([[], [{ id: 'c1' }]]);
    await expect(makeService(db).activateCard(db, 'm1', 'c1')).rejects.toThrow(ConflictException);
  });

  it("404 for a card that isn't the member's", async () => {
    const { db } = makeDb([[], []]);
    await expect(makeService(db).activateCard(db, 'm1', 'c1')).rejects.toThrow(NotFoundException);
  });
});

describe('Entitlements — what the member has', () => {
  const card = (over: Record<string, unknown>) => ({
    id: 'c',
    label: 'Денний · 1 місяць',
    activateBy: '2026-11-01',
    validFrom: null,
    validUntil: null,
    ...over,
  });

  it('a waiting card counts as a card', async () => {
    const { db } = makeDb([[card({})]]);
    expect(await makeService(db).usableCard('m1')).toMatchObject({ id: 'c', state: 'waiting' });
  });

  it('a burned or expired card does not', async () => {
    const { db } = makeDb([
      [card({ activateBy: '2026-10-22' }), card({ validFrom: '2026-09-01', validUntil: '2026-10-01' })],
    ]);
    expect(await makeService(db).usableCard('m1')).toBeNull();
  });

  it('an active card wins over a waiting one', async () => {
    const { db } = makeDb([[card({ id: 'w' }), card({ id: 'a', validFrom: '2026-10-01', validUntil: '2026-11-01' })]]);
    expect(await makeService(db).usableCard('m1')).toMatchObject({
      id: 'a',
      state: 'active',
      validUntil: '2026-11-01',
    });
  });

  it('group trainings left for a date: only passes usable on it', async () => {
    const { db } = makeDb([
      [
        {
          total: 10,
          used: 3,
          purchasedOn: '2026-10-23',
          activateBy: '2026-11-23',
          activatedOn: null,
          validUntil: null,
        },
        { total: 1, used: 0, purchasedOn: '2026-09-01', activateBy: '2026-10-01', activatedOn: null, validUntil: null },
      ],
    ]);
    expect(await makeService(db).groupPassLeft('m1', '2026-10-24')).toBe(7);
  });
});

describe('Entitlements — manual club card', () => {
  it('only a club card item can be added by hand', async () => {
    const { db } = makeDb([[{ section: 'assigned', title: 'Персональне', optionLabel: '1 тренування' }]]);
    await expect(makeService(db).addManualCard(db, 'm1', 't1', 'price-1', false)).rejects.toThrow(BadRequestException);
  });

  it('added by hand, it waits for activation, signed by the trainer', async () => {
    const { db, inserts } = makeDb([
      [{ section: 'club_card', title: 'Денний', optionLabel: '1 місяць', durationMonths: 1 }],
    ]);
    await makeService(db).addManualCard(db, 'm1', 't1', 'price-1', false);
    expect(inserts[0]).toEqual({
      table: clubCards,
      values: {
        memberId: 'm1',
        purchaseItemId: null,
        label: 'Денний · 1 місяць',
        validFrom: null,
        validUntil: null,
        durationMonths: 1,
        activateBy: '2026-11-23',
        addedBy: 't1',
      },
    });
  });

  it('«Додати й активувати з сьогодні» gives it dates from today', async () => {
    const { db, inserts } = makeDb([
      [{ section: 'club_card', title: 'Денний', optionLabel: '1 місяць', durationMonths: 1 }],
    ]);
    await makeService(db).addManualCard(db, 'm1', 't1', 'price-1', true);
    expect(inserts[0].values).toMatchObject({ validFrom: '2026-10-23', validUntil: '2026-11-23' });
  });
});
