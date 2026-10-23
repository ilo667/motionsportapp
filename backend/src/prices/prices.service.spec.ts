import { ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DateTime } from 'luxon';
import { PricesService } from './prices.service';
import { PricesController, PublicPricesController } from './prices.controller';
import { AdminGuard } from '../common/guards/admin.guard';
import { UpdatePriceDto } from './dto/update-price.dto';
import { DEFAULT_PRICE_LIST, PRICE_SECTIONS } from './price-list';
import { KY_ZONE, ASSIGNED_TYPES } from '../schedule/training-types';

const NOW = DateTime.fromISO('2026-10-23T12:00:00', { zone: KY_ZONE });

// Drizzle chain mock: each awaited query takes the next result from `results`; set/values payloads are recorded
function makeDb(results: unknown[][]) {
  const queue = [...results];
  const sets: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  function link(): any {
    const chain: any = {
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve(queue.shift() ?? []).then(resolve, reject),
    };
    for (const m of ['from', 'where', 'orderBy', 'limit', 'returning', 'leftJoin', 'innerJoin']) {
      chain[m] = jest.fn(() => chain);
    }
    chain.set = jest.fn((v: Record<string, unknown>) => {
      sets.push(v);
      return chain;
    });
    chain.values = jest.fn((v: Record<string, unknown>) => {
      inserts.push(v);
      return chain;
    });
    return chain;
  }
  const db: any = { select: jest.fn(() => link()), update: jest.fn(() => link()), insert: jest.fn(() => link()) };
  db.transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(db));
  return { db, sets, inserts };
}

function makeService(db: any) {
  return new PricesService({ db } as any, { now: () => NOW });
}

describe('Prices', () => {
  it('changes the amount and logs who changed it', async () => {
    const { db, sets, inserts } = makeDb([[{ id: 'p1', amountUah: 650 }], []]);
    await expect(
      makeService(db).updatePrice('trainer-1', 'p1', { amountUah: 650, expectedAmountUah: 600 }),
    ).resolves.toEqual({ id: 'p1', amountUah: 650 });

    expect(sets).toEqual([{ amountUah: 650, updatedBy: 'trainer-1', updatedAt: NOW.toJSDate() }]);
    expect(inserts).toEqual([
      { priceItemId: 'p1', oldAmountUah: 600, newAmountUah: 650, changedBy: 'trainer-1', changedAt: NOW.toJSDate() },
    ]);
  });

  it('answers 409 with the current amount when another trainer changed it meanwhile', async () => {
    // compare-and-set updates nothing, then the current row is read
    const { db, inserts } = makeDb([[], [{ amountUah: 700, updatedBy: 'demo' }]]);
    const err = await makeService(db)
      .updatePrice('trainer-1', 'p1', { amountUah: 650, expectedAmountUah: 600 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ amountUah: 700, updatedBy: 'demo' });
    expect(inserts).toEqual([]);
  });

  it('answers 404 for an unknown price', async () => {
    const { db } = makeDb([[], []]);
    await expect(
      makeService(db).updatePrice('trainer-1', 'missing', { amountUah: 650, expectedAmountUah: 600 }),
    ).rejects.toThrow(NotFoundException);
  });

  it('saving the same amount writes nothing', async () => {
    const { db, sets, inserts } = makeDb([[{ amountUah: 600, updatedBy: null }]]);
    await expect(
      makeService(db).updatePrice('trainer-1', 'p1', { amountUah: 600, expectedAmountUah: 600 }),
    ).resolves.toEqual({ id: 'p1', amountUah: 600 });
    expect(sets).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it('a seeded price has no author or change time', async () => {
    const updatedAt = new Date('2026-10-23T09:00:00Z');
    const { db } = makeDb([
      [
        { id: 'p1', amountUah: 600, updatedBy: null, updatedAt },
        { id: 'p2', amountUah: 400, updatedBy: 'demo', updatedAt },
      ],
      [],
    ]);
    const { items } = await makeService(db).getPrices();
    expect(items.map((i) => i.updatedAt)).toEqual([null, updatedAt.toISOString()]);
  });

  it.each([0, -5, 100_001, 1.5, '700'])('rejects amount %p', async (amountUah) => {
    const errors = await validate(plainToInstance(UpdatePriceDto, { amountUah, expectedAmountUah: 600 }));
    expect(errors).toHaveLength(1);
  });

  it('accepts a whole amount within the limit', async () => {
    expect(await validate(plainToInstance(UpdatePriceDto, { amountUah: 100_000, expectedAmountUah: 600 }))).toEqual([]);
  });

  // Public «Ціни» page: amounts only, never who changed them
  it('the public price list has no trainer names or change times', async () => {
    const row = { id: 'p1', section: 'group', title: 'Разове відвідування', optionLabel: null, amountUah: 250 };
    const { db } = makeDb([[row]]);
    expect(await new PricesService({ db } as any, { now: () => NOW }).getPublicPrices()).toEqual([row]);
    expect(db.select).toHaveBeenCalledWith({
      id: expect.anything(),
      section: expect.anything(),
      title: expect.anything(),
      optionLabel: expect.anything(),
      amountUah: expect.anything(),
    });
  });

  it('the public price list needs no sign-in (no guards)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PublicPricesController)).toBeUndefined();
  });

  it('price endpoints are admin-only (AdminGuard on the controller)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PricesController) as unknown[];
    expect(guards).toContain(AdminGuard);
  });

  it('seed price list: unique codes, known sections, whole positive amounts', () => {
    const codes = DEFAULT_PRICE_LIST.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const p of DEFAULT_PRICE_LIST) {
      expect(PRICE_SECTIONS).toContain(p.section);
      expect(Number.isInteger(p.amountUah) && p.amountUah > 0).toBe(true);
    }
  });

  // What a purchase gives: a club card lasts durationMonths (0 = that day only), a trainer package holds trainingCount
  it('seed price list: everything has a duration; trainer services and group passes a type and a count', () => {
    for (const p of DEFAULT_PRICE_LIST) {
      if (p.section === 'club_card') {
        expect(Number.isInteger(p.durationMonths) && p.durationMonths! >= 0).toBe(true);
        expect(p.trainingType).toBeUndefined();
      } else if (p.section === 'assigned') {
        expect(ASSIGNED_TYPES).toContain(p.trainingType);
        expect([1, 6, 8, 12]).toContain(p.trainingCount);
        expect(p.durationMonths).toBe(1);
      } else {
        expect(p.trainingType).toBe('групові');
        expect([1, 10]).toContain(p.trainingCount);
        expect(p.durationMonths).toBe(1);
      }
    }
    expect(DEFAULT_PRICE_LIST.find((p) => p.code === 'club_single')?.durationMonths).toBe(0);
    expect(DEFAULT_PRICE_LIST.find((p) => p.code === 'personal_8')).toMatchObject({
      trainingType: 'персональні',
      trainingCount: 8,
    });
  });
});
