import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DateTime } from 'luxon';
import { PurchasesService } from './purchases.service';
import { PurchasesController } from './purchases.controller';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { MemberGuard } from '../common/guards/member.guard';
import { payments, purchases, purchaseItems } from '../database/schema';
import { KY_ZONE } from '../schedule/training-types';
import { tryBookGroup } from '../booking/group-booking';

jest.mock('../booking/group-booking', () => ({ tryBookGroup: jest.fn() }));
const mockTryBook = tryBookGroup as jest.Mock;
beforeEach(() => mockTryBook.mockReset());

const NOW = DateTime.fromISO('2026-10-23T12:00:00', { zone: KY_ZONE });

// Drizzle chain mock: each awaited read takes the next result; inserts return `[{ id: 'purchase-1' }]`
function makeDb(results: unknown[][]) {
  const queue = [...results];
  const inserts: { table: unknown; values: unknown }[] = [];
  const sets: Record<string, unknown>[] = [];
  const updated: unknown[] = [];
  function link(result?: () => unknown): any {
    const chain: any = {
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve(result ? result() : (queue.shift() ?? [])).then(resolve, reject),
    };
    for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin', 'for', 'returning']) {
      chain[m] = jest.fn(() => chain);
    }
    chain.set = jest.fn((v: Record<string, unknown>) => {
      sets.push(v);
      return chain;
    });
    return chain;
  }
  const db: any = {
    select: jest.fn(() => link()),
    update: jest.fn((table: unknown) => {
      updated.push(table);
      return link();
    }),
    insert: jest.fn((table: unknown) => {
      const chain = link(() => [{ id: 'purchase-1' }]);
      chain.values = jest.fn((values: unknown) => {
        inserts.push({ table, values });
        return chain;
      });
      return chain;
    }),
  };
  db.transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(db));
  return { db, inserts, sets, updated };
}

const CARD = { id: 'price-card', section: 'club_card', title: 'Повний день', optionLabel: '1 місяць', amountUah: 1400 };
const PERSONAL = {
  id: 'price-p8',
  section: 'assigned',
  title: 'Персональне',
  optionLabel: '8 тренувань',
  amountUah: 3600,
};
const SPLIT = { id: 'price-s1', section: 'assigned', title: 'Спліт', optionLabel: '1 тренування', amountUah: 400 };
const GROUP = { id: 'price-g', section: 'group', title: 'Абонемент', optionLabel: '10 занять', amountUah: 2200 };
const MEMBER = [{ trainerId: 'trainer-1', displayName: 'Катя' }];

function makeService(db: any, opts: { card?: unknown; pushFails?: boolean } = {}) {
  const entitlements = {
    usableCard: jest.fn().mockResolvedValue(opts.card ?? null),
    packagesOf: jest.fn().mockResolvedValue([]),
  };
  const payments = { checkoutPurchase: jest.fn().mockResolvedValue({ data: 'd', signature: 's' }) };
  const notifications = {
    enqueueAndProcess: opts.pushFails
      ? jest.fn().mockRejectedValue(new Error('push down'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const svc = new PurchasesService(
    { db } as any,
    { now: () => NOW },
    entitlements as any,
    payments as any,
    notifications as any,
  );
  return { svc, entitlements, payments, notifications };
}

describe('Purchases — create', () => {
  it('404 for an unknown price item', async () => {
    const { db } = makeDb([[PERSONAL]]);
    await expect(
      makeService(db).svc.create('m1', { priceItemIds: ['price-p8', 'price-x'], method: 'LIQPAY' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('a club card alone can be bought', async () => {
    const { db, inserts } = makeDb([[CARD], MEMBER, []]);
    const { svc, payments } = makeService(db);
    await svc.create('m1', { priceItemIds: ['price-card'], method: 'LIQPAY' });
    expect(inserts.find((i) => i.table === purchaseItems)?.values).toEqual([
      expect.objectContaining({ priceItemId: 'price-card', amountUah: 1400 }),
    ]);
    expect(payments.checkoutPurchase).toHaveBeenCalledWith('purchase-1', 'm1');
  });

  it('a group pass is bought alone: with a card or a trainer service → 400', async () => {
    const a = makeDb([[GROUP, CARD]]);
    await expect(
      makeService(a.db).svc.create('m1', { priceItemIds: ['price-g', 'price-card'], method: 'LIQPAY' }),
    ).rejects.toThrow(BadRequestException);
    const b = makeDb([[GROUP, PERSONAL]]);
    await expect(
      makeService(b.db, { card: { id: 'c' } }).svc.create('m1', {
        priceItemIds: ['price-g', 'price-p8'],
        method: 'LIQPAY',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('a slot goes only with a group pass → 400 otherwise', async () => {
    const { db } = makeDb([[CARD]]);
    await expect(
      makeService(db).svc.create('m1', { priceItemIds: ['price-card'], method: 'LIQPAY', slotId: 'slot-1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('LiqPay group pass from «Записатися»: remembers the slot, books nothing yet', async () => {
    const { db, inserts } = makeDb([[GROUP], MEMBER, []]);
    await makeService(db).svc.create('m1', { priceItemIds: ['price-g'], method: 'LIQPAY', slotId: 'slot-1' });
    expect(inserts.find((i) => i.table === purchases)?.values).toMatchObject({ slotId: 'slot-1', method: 'LIQPAY' });
    expect(mockTryBook).not.toHaveBeenCalled();
  });

  it('cash for a group pass books the slot at once and remembers the booking', async () => {
    mockTryBook.mockResolvedValueOnce({ ok: true, bookingId: 'b1' });
    const { db, sets } = makeDb([[GROUP], MEMBER, []]);
    const { svc, notifications } = makeService(db);
    await svc.create('m1', { priceItemIds: ['price-g'], method: 'CASH', slotId: 'slot-1' });
    expect(mockTryBook).toHaveBeenCalledWith(db, NOW, 'm1', 'slot-1');
    expect(sets).toContainEqual({ bookingId: 'b1' });
    expect(notifications.enqueueAndProcess).toHaveBeenCalledWith(
      'CASH_REQUESTED',
      expect.any(String),
      expect.anything(),
    );
  });

  it('cash for a group pass on a full slot: 409 and the purchase is rolled back (the error leaves the transaction)', async () => {
    mockTryBook.mockResolvedValueOnce({ ok: false, reason: 'FULL' });
    const { db } = makeDb([[GROUP], MEMBER, []]);
    const { svc, notifications } = makeService(db);
    await expect(svc.create('m1', { priceItemIds: ['price-g'], method: 'CASH', slotId: 'slot-1' })).rejects.toThrow(
      'Slot is full',
    );
    expect(notifications.enqueueAndProcess).not.toHaveBeenCalled();
  });

  it('400 for two trainer services', async () => {
    const { db } = makeDb([[PERSONAL, SPLIT]]);
    await expect(
      makeService(db, { card: { id: 'c' } }).svc.create('m1', {
        priceItemIds: ['price-p8', 'price-s1'],
        method: 'LIQPAY',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('400 Club card required when the member has no valid card and did not add one', async () => {
    const { db } = makeDb([[PERSONAL]]);
    await expect(makeService(db).svc.create('m1', { priceItemIds: ['price-p8'], method: 'LIQPAY' })).rejects.toThrow(
      'Club card required',
    );
  });

  it('409 while another purchase awaits payment', async () => {
    const { db } = makeDb([[CARD, PERSONAL], MEMBER, [{ id: 'old' }]]);
    await expect(
      makeService(db).svc.create('m1', { priceItemIds: ['price-card', 'price-p8'], method: 'LIQPAY' }),
    ).rejects.toThrow(ConflictException);
  });

  it('400 for cash when the member has no trainer, and nothing is created', async () => {
    const { db, inserts } = makeDb([[CARD, PERSONAL], [{ trainerId: null, displayName: 'Катя' }], []]);
    await expect(
      makeService(db).svc.create('m1', { priceItemIds: ['price-card', 'price-p8'], method: 'CASH' }),
    ).rejects.toThrow('No trainer to pay cash to');
    expect(inserts).toEqual([]);
  });

  it('copies the price list amounts into the purchase and starts a LiqPay checkout', async () => {
    const { db, inserts } = makeDb([[CARD, PERSONAL], MEMBER, []]);
    const { svc, payments } = makeService(db);
    await expect(svc.create('m1', { priceItemIds: ['price-card', 'price-p8'], method: 'LIQPAY' })).resolves.toEqual({
      purchaseId: 'purchase-1',
      checkout: { data: 'd', signature: 's' },
    });
    expect(inserts[0]).toEqual({
      table: purchases,
      values: {
        memberId: 'm1',
        trainerId: 'trainer-1',
        method: 'LIQPAY',
        status: 'PENDING',
        totalUah: 5000,
        slotId: null,
      },
    });
    expect(inserts[1]).toEqual({
      table: purchaseItems,
      values: [
        {
          purchaseId: 'purchase-1',
          priceItemId: 'price-card',
          title: 'Повний день',
          optionLabel: '1 місяць',
          amountUah: 1400,
        },
        {
          purchaseId: 'purchase-1',
          priceItemId: 'price-p8',
          title: 'Персональне',
          optionLabel: '8 тренувань',
          amountUah: 3600,
        },
      ],
    });
    expect(payments.checkoutPurchase).toHaveBeenCalledWith('purchase-1', 'm1');
  });

  it('with a valid card the service alone is enough', async () => {
    const { db } = makeDb([[SPLIT], MEMBER, []]);
    await expect(
      makeService(db, { card: { id: 'c', label: 'Денний', validUntil: '2026-11-01' } }).svc.create('m1', {
        priceItemIds: ['price-s1'],
        method: 'LIQPAY',
      }),
    ).resolves.toHaveProperty('purchaseId', 'purchase-1');
  });

  it('cash: tells the trainer, no LiqPay', async () => {
    const { db } = makeDb([[CARD, PERSONAL], MEMBER, []]);
    const { svc, payments, notifications } = makeService(db);
    await expect(svc.create('m1', { priceItemIds: ['price-card', 'price-p8'], method: 'CASH' })).resolves.toEqual({
      purchaseId: 'purchase-1',
    });
    expect(payments.checkoutPurchase).not.toHaveBeenCalled();
    expect(notifications.enqueueAndProcess).toHaveBeenCalledWith('CASH_REQUESTED', 'cash-requested:purchase-1', {
      trainerId: 'trainer-1',
      displayName: 'Катя',
      totalUah: 5000,
    });
  });

  it('a failed push never fails the cash request', async () => {
    const { db } = makeDb([[CARD, PERSONAL], MEMBER, []]);
    await expect(
      makeService(db, { pushFails: true }).svc.create('m1', {
        priceItemIds: ['price-card', 'price-p8'],
        method: 'CASH',
      }),
    ).resolves.toEqual({ purchaseId: 'purchase-1' });
  });
});

describe('Purchases — cancel', () => {
  it('cancels own pending purchase and its open LiqPay attempts', async () => {
    const { db, sets } = makeDb([[], [{ id: 'purchase-1' }]]);
    await makeService(db).svc.cancel('m1', 'purchase-1');
    expect(sets).toContainEqual(expect.objectContaining({ status: 'CANCELLED' }));
    expect(sets).toContainEqual(expect.objectContaining({ status: 'REPLACED' }));
  });

  // Same lock order as the LiqPay paths (payment row, then purchase row), so a cancel and a callback at once
  // wait for each other instead of deadlocking
  it('touches the payments before the purchase', async () => {
    const { db, updated } = makeDb([[], [{ id: 'purchase-1' }]]);
    await makeService(db).svc.cancel('m1', 'purchase-1');
    expect(updated).toEqual([payments, purchases]);
  });

  it("404 for someone else's purchase", async () => {
    const { db } = makeDb([[], [], []]);
    await expect(makeService(db).svc.cancel('m2', 'purchase-1')).rejects.toThrow(NotFoundException);
  });

  it('409 when it was already paid or decided', async () => {
    const { db } = makeDb([[], [], [{ status: 'PAID' }]]);
    await expect(makeService(db).svc.cancel('m1', 'purchase-1')).rejects.toThrow(ConflictException);
  });
});

describe('Purchases — request shape', () => {
  it.each([
    [{ priceItemIds: [], method: 'CASH' }],
    [{ priceItemIds: ['not-a-uuid'], method: 'CASH' }],
    [{ priceItemIds: ['5f0c3a52-0b7e-4a3c-9a4e-1f2b3c4d5e6f'], method: 'CARD' }],
  ])('rejects %j', async (body) => {
    expect((await validate(plainToInstance(CreatePurchaseDto, body))).length).toBeGreaterThan(0);
  });

  it('purchase endpoints are member-only (MemberGuard on the controller)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PurchasesController) as unknown[];
    expect(guards).toContain(MemberGuard);
  });
});
