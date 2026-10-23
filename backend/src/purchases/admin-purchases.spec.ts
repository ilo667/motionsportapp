import { ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DateTime } from 'luxon';
import { PurchasesService } from './purchases.service';
import { AdminPurchasesController } from './admin-purchases.controller';
import { AdminGuard } from '../common/guards/admin.guard';
import { KY_ZONE } from '../schedule/training-types';

const NOW = DateTime.fromISO('2026-10-23T12:00:00', { zone: KY_ZONE });

// Drizzle chain mock: reads take the next result from `results`; an UPDATE … RETURNING answers with
// `updateResult()` so a test can make the compare-and-set lose
function makeDb(results: unknown[][], updateResult: () => unknown[] = () => [{ id: 'purchase-1' }]) {
  const queue = [...results];
  const sets: Record<string, unknown>[] = [];
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
  const db: any = { select: jest.fn(() => link()), update: jest.fn(() => link(updateResult)) };
  db.transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(db));
  return { db, sets };
}

function makeService(db: any) {
  const entitlements = {
    activate: jest.fn().mockResolvedValue(undefined),
    addManualCard: jest.fn(),
    activateCard: jest.fn(),
  };
  const svc = new PurchasesService({ db } as any, { now: () => NOW }, entitlements as any, {} as any, {} as any);
  return { svc, entitlements };
}

describe('Trainer — cash requests', () => {
  it('confirming marks the purchase PAID by this trainer and activates it once', async () => {
    const { db, sets } = makeDb([]);
    const { svc, entitlements } = makeService(db);
    await svc.confirmCash('trainer-1', 'purchase-1');
    expect(sets).toEqual([{ status: 'PAID', decidedBy: 'trainer-1', decidedAt: NOW.toJSDate() }]);
    expect(entitlements.activate).toHaveBeenCalledTimes(1);
    expect(entitlements.activate).toHaveBeenCalledWith(db, 'purchase-1');
  });

  it('confirming twice: 409 the second time, still one activation', async () => {
    let first = true;
    const { db } = makeDb([[{ status: 'PAID' }]], () => {
      const won = first;
      first = false;
      return won ? [{ id: 'purchase-1' }] : [];
    });
    const { svc, entitlements } = makeService(db);
    await svc.confirmCash('trainer-1', 'purchase-1');
    await expect(svc.confirmCash('trainer-1', 'purchase-1')).rejects.toThrow(ConflictException);
    expect(entitlements.activate).toHaveBeenCalledTimes(1);
  });

  it("another trainer's request (or a LiqPay purchase) answers 404 and activates nothing", async () => {
    const { db } = makeDb([[]], () => []);
    const { svc, entitlements } = makeService(db);
    await expect(svc.confirmCash('trainer-2', 'purchase-1')).rejects.toThrow(NotFoundException);
    expect(entitlements.activate).not.toHaveBeenCalled();
  });

  it('rejecting ends the purchase and activates nothing', async () => {
    const { db, sets } = makeDb([]);
    const { svc, entitlements } = makeService(db);
    await svc.rejectCash('trainer-1', 'purchase-1');
    expect(sets).toEqual([{ status: 'REJECTED', decidedBy: 'trainer-1', decidedAt: NOW.toJSDate() }]);
    expect(entitlements.activate).not.toHaveBeenCalled();
  });
});

describe('Trainer — client purchases', () => {
  it("another trainer's client answers 404", async () => {
    const { db } = makeDb([[]]);
    await expect(makeService(db).svc.memberPurchases('trainer-2', 'm1')).rejects.toThrow(NotFoundException);
  });

  it('adding a card by hand checks the client is visible to this trainer first', async () => {
    const { db } = makeDb([[]]);
    const { svc, entitlements } = makeService(db);
    await expect(svc.addCard('trainer-2', 'm1', 'price-card', false)).rejects.toThrow(NotFoundException);
    expect(entitlements.addManualCard).not.toHaveBeenCalled();
  });

  it('adds the card for a visible client, signed by the trainer', async () => {
    const { db } = makeDb([[{ id: 'm1' }]]);
    const { svc, entitlements } = makeService(db);
    await svc.addCard('trainer-1', 'm1', 'price-card', false);
    expect(entitlements.addManualCard).toHaveBeenCalledWith(db, 'm1', 'trainer-1', 'price-card', false);
  });

  it('«Додати й активувати з сьогодні» passes activate on', async () => {
    const { db } = makeDb([[{ id: 'm1' }]]);
    const { svc, entitlements } = makeService(db);
    await svc.addCard('trainer-1', 'm1', 'price-card', true);
    expect(entitlements.addManualCard).toHaveBeenCalledWith(db, 'm1', 'trainer-1', 'price-card', true);
  });

  it('activates a waiting card of a visible client', async () => {
    const { db } = makeDb([[{ id: 'm1' }]]);
    const { svc, entitlements } = makeService(db);
    await svc.activateCard('trainer-1', 'm1', 'card-1');
    expect(entitlements.activateCard).toHaveBeenCalledWith(db, 'm1', 'card-1');
  });

  it("another trainer's client: 404, the card is not touched", async () => {
    const { db } = makeDb([[]]);
    const { svc, entitlements } = makeService(db);
    await expect(svc.activateCard('trainer-1', 'm1', 'card-1')).rejects.toThrow(NotFoundException);
    expect(entitlements.activateCard).not.toHaveBeenCalled();
  });

  it('rejecting cash for a group pass leaves the booking alone', async () => {
    const { db } = makeDb([]);
    const { svc } = makeService(db);
    await svc.rejectCash('trainer-1', 'purchase-1');
    // Only the purchase row is updated
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('trainer purchase endpoints are admin-only (AdminGuard on the controller)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminPurchasesController) as unknown[];
    expect(guards).toContain(AdminGuard);
  });
});
