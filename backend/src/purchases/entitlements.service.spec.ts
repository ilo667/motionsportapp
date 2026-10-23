import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { EntitlementsService } from './entitlements.service';
import { clubCards, packages, packageSpends } from '../database/schema';
import { KY_ZONE } from '../schedule/training-types';

const NOW = DateTime.fromISO('2026-10-23T12:00:00', { zone: KY_ZONE });

// Drizzle chain mock: each awaited query takes the next result from `results`.
// Inserts and deletes are recorded with the table they hit
function makeDb(results: unknown[][]) {
  const queue = [...results];
  const inserts: { table: unknown; values: unknown }[] = [];
  const deletes: unknown[] = [];
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
  };
  return { db, inserts, deletes, selects: () => selects };
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

describe('Entitlements — activation', () => {
  it('a club card lasts its months from today', async () => {
    const { db, inserts } = makeDb([[line({})]]);
    await makeService(db).activate(db, 'p1');
    expect(inserts).toEqual([
      {
        table: clubCards,
        values: {
          memberId: 'm1',
          purchaseItemId: 'line-1',
          label: 'Повний день · 3 місяці',
          validFrom: '2026-10-23',
          validUntil: '2027-01-23',
          durationMonths: 3,
          activateBy: '2026-11-23',
        },
      },
    ]);
  });

  it('«Разове відвідування» is valid today only', async () => {
    const { db, inserts } = makeDb([[line({ title: 'Разове відвідування', optionLabel: null, durationMonths: 0 })]]);
    await makeService(db).activate(db, 'p1');
    expect(inserts[0].values).toMatchObject({
      label: 'Разове відвідування',
      validFrom: '2026-10-23',
      validUntil: '2026-10-23',
    });
  });

  it('a trainer service becomes a package of its trainings', async () => {
    const { db, inserts } = makeDb([
      [
        line({
          id: 'line-2',
          title: 'Персональне',
          optionLabel: '8 тренувань',
          section: 'assigned',
          durationMonths: null,
          trainingType: 'персональні',
          trainingCount: 8,
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
          purchasedOn: '2026-10-23',
          activateBy: '2026-11-23',
        },
      },
    ]);
  });
});

describe('Entitlements — spends', () => {
  const booking = (over: Record<string, unknown>) => ({
    memberId: 'm1',
    trainingType: 'персональні',
    marked: 'b1',
    spentFrom: null,
    ...over,
  });

  // Reads: the booking, then the member's packages of that type locked (no counts: a count in the locking
  // statement would use a snapshot from before the lock wait), then the spends counted in a fresh statement
  it('a mark spends from the oldest package that has trainings left', async () => {
    const { db, inserts } = makeDb([
      [booking({})],
      [
        { id: 'old', total: 1 },
        { id: 'new', total: 8 },
      ],
      [
        { packageId: 'old', used: 1 },
        { packageId: 'new', used: 5 },
      ],
    ]);
    await makeService(db).syncSpend(db, 'b1');
    expect(inserts).toEqual([{ table: packageSpends, values: { bookingId: 'b1', packageId: 'new' } }]);
  });

  it('counts spends only after the lock, in its own statement (two marks at once cannot both take the last one)', async () => {
    const { db, inserts, selects } = makeDb([
      [booking({})],
      [{ id: 'only', total: 1 }],
      [{ packageId: 'only', used: 1 }],
    ]);
    await makeService(db).syncSpend(db, 'b1');
    expect(selects()).toBe(3);
    expect(inserts).toEqual([]);
  });

  it('changing ✓ to ✗ keeps the single spend', async () => {
    const { db, inserts, deletes } = makeDb([[booking({ spentFrom: 'new' })]]);
    await makeService(db).syncSpend(db, 'b1');
    expect(inserts).toEqual([]);
    expect(deletes).toEqual([]);
  });

  it('«—» gives the training back (the spend row goes)', async () => {
    const { db, deletes } = makeDb([[booking({ marked: null, spentFrom: 'new' })]]);
    await makeService(db).syncSpend(db, 'b1');
    expect(deletes).toEqual([packageSpends]);
  });

  it('no package left: the mark stays, nothing is spent', async () => {
    const { db, inserts } = makeDb([[booking({})], [{ id: 'old', total: 1 }], [{ packageId: 'old', used: 1 }]]);
    await expect(makeService(db).syncSpend(db, 'b1')).resolves.toBeUndefined();
    expect(inserts).toEqual([]);
  });

  it('a group training spends nothing', async () => {
    const { db, inserts, selects } = makeDb([[booking({ trainingType: 'групові' })]]);
    await makeService(db).syncSpend(db, 'b1');
    expect(selects()).toBe(1);
    expect(inserts).toEqual([]);
  });
});

describe('Entitlements — manual club card', () => {
  it('only a club card item can be added by hand', async () => {
    const { db } = makeDb([[{ section: 'assigned', title: 'Персональне', optionLabel: '1 тренування' }]]);
    await expect(makeService(db).addManualCard(db, 'm1', 't1', 'price-1')).rejects.toThrow(BadRequestException);
  });

  it('adds the card from today, signed by the trainer', async () => {
    const { db, inserts } = makeDb([
      [{ section: 'club_card', title: 'Денний', optionLabel: '1 місяць', durationMonths: 1 }],
    ]);
    await makeService(db).addManualCard(db, 'm1', 't1', 'price-1');
    expect(inserts[0]).toEqual({
      table: clubCards,
      values: {
        memberId: 'm1',
        purchaseItemId: null,
        label: 'Денний · 1 місяць',
        validFrom: '2026-10-23',
        validUntil: '2026-11-23',
        durationMonths: 1,
        activateBy: '2026-11-23',
        addedBy: 't1',
      },
    });
  });
});
