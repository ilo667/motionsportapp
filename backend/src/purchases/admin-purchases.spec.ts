import { ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DateTime } from 'luxon';
import { AdminPurchasesService } from './admin-purchases.service';
import { AdminPurchasesController } from './admin-purchases.controller';
import { AdminGuard } from '../common/guards/admin.guard';
import { KY_ZONE } from '../schedule/training-types';
import { lockMember } from '../booking/group-booking';

// lockMember is tested in group-booking.spec; here only that it is taken
jest.mock('../booking/group-booking', () => ({
  ...jest.requireActual('../booking/group-booking'),
  lockMember: jest.fn().mockResolvedValue({ trainerId: 'trainer-1', displayName: 'Катя' }),
}));
const mockLockMember = lockMember as jest.Mock;
beforeEach(() => mockLockMember.mockClear());

const NOW = DateTime.fromISO('2026-10-23T12:00:00', { zone: KY_ZONE });

// Drizzle chain mock: reads take the next result; `updateResult` returning [] loses the compare-and-set
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
    usableCard: jest.fn().mockResolvedValue(null),
  };
  const notifications = { enqueueAndProcess: jest.fn().mockResolvedValue(undefined) };
  const svc = new AdminPurchasesService({ db } as any, { now: () => NOW }, entitlements as any, notifications as any);
  return { svc, entitlements, notifications };
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

  it('409 when the client already has a club card (active or waiting), nothing added', async () => {
    const { db } = makeDb([[{ id: 'm1' }]]);
    const { svc, entitlements } = makeService(db);
    entitlements.usableCard.mockResolvedValue({ id: 'c1', state: 'waiting' });
    await expect(svc.addCard('trainer-1', 'm1', 'price-card', false)).rejects.toThrow(ConflictException);
    expect(entitlements.addManualCard).not.toHaveBeenCalled();
  });

  it('adds the card in one transaction under the member lock: two «Додати» at once give one card', async () => {
    const { db } = makeDb([[{ id: 'm1' }]]);
    const tx = { ...db };
    db.transaction = jest.fn((fn: (t: unknown) => unknown) => fn(tx));
    const { svc, entitlements } = makeService(db);
    await svc.addCard('trainer-1', 'm1', 'price-card', false);
    expect(mockLockMember).toHaveBeenCalledWith(tx, 'm1');
    expect(entitlements.usableCard).toHaveBeenCalledWith('m1', tx);
    expect(mockLockMember.mock.invocationCallOrder[0]).toBeLessThan(
      entitlements.usableCard.mock.invocationCallOrder[0],
    );
    expect(entitlements.addManualCard).toHaveBeenCalledWith(tx, 'm1', 'trainer-1', 'price-card', false);
  });

  it('a frozen client: 409, no card added', async () => {
    // The visible member, then an active freeze over today
    const freeze = { id: 'f1', memberId: 'm1', status: 'ACTIVE', startedOn: '2026-10-20', endsOn: '2026-11-19' };
    const { db } = makeDb([[{ id: 'm1' }], [freeze]]);
    const { svc, entitlements } = makeService(db);
    await expect(svc.addCard('trainer-1', 'm1', 'price-card', false)).rejects.toThrow('Member is frozen');
    expect(entitlements.addManualCard).not.toHaveBeenCalled();
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
    const tx = { ...db };
    db.transaction = jest.fn((fn: (t: unknown) => unknown) => fn(tx));
    await svc.activateCard('trainer-1', 'm1', 'card-1');
    expect(mockLockMember).toHaveBeenCalledWith(tx, 'm1');
    expect(entitlements.activateCard).toHaveBeenCalledWith(tx, 'm1', 'card-1');
  });

  it('a frozen client: 409, the card is not started', async () => {
    const freeze = { id: 'f1', memberId: 'm1', status: 'ACTIVE', startedOn: '2026-10-20', endsOn: '2026-11-19' };
    const { db } = makeDb([[{ id: 'm1' }], [freeze]]);
    const { svc, entitlements } = makeService(db);
    await expect(svc.activateCard('trainer-1', 'm1', 'card-1')).rejects.toThrow('Member is frozen');
    expect(entitlements.activateCard).not.toHaveBeenCalled();
  });

  it("another trainer's client: 404, the card is not touched", async () => {
    const { db } = makeDb([[]]);
    const { svc, entitlements } = makeService(db);
    await expect(svc.activateCard('trainer-1', 'm1', 'card-1')).rejects.toThrow(NotFoundException);
    expect(entitlements.activateCard).not.toHaveBeenCalled();
  });

  it('rejecting cash for a group pass cancels the booking it made and frees the seat', async () => {
    // The purchase answers with its booking; the booking with its slot
    const { db, sets } = makeDb([], () => [{ id: 'purchase-1', bookingId: 'b1', slotId: 's1' }]);
    db.delete = jest.fn(() => ({ where: () => Promise.resolve() }));
    const { svc } = makeService(db);
    await svc.rejectCash('trainer-1', 'purchase-1');
    expect(sets).toContainEqual(expect.objectContaining({ status: 'CANCELLED', cancelledAt: expect.any(Date) }));
    expect(sets).toContainEqual({ bookedCount: expect.anything() });
    expect(db.delete).toHaveBeenCalled(); // a mark on it goes too
  });

  it('rejecting cash in a full group training tells those waiting for a seat, not the member', async () => {
    const { db } = makeDb(
      [[{ bookedCount: 8, capacity: 8, trainingType: 'group' }], [{ slotTime: '19:00', localDate: '2026-10-24' }]],
      () => [{ id: 'purchase-1', bookingId: 'b1', slotId: 's1', memberId: 'm1' }],
    );
    db.delete = jest.fn(() => ({ where: () => Promise.resolve() }));
    const { svc, notifications } = makeService(db);
    await svc.rejectCash('trainer-1', 'purchase-1');
    expect(notifications.enqueueAndProcess).toHaveBeenCalledWith('VACANCY', 'vacancy:s1:b1', {
      slotId: 's1',
      slotTime: '19:00',
      localDate: '2026-10-24',
      excludeMemberId: 'm1',
    });
  });

  it('rejecting cash in a training that was not full sends nothing', async () => {
    const { db } = makeDb([[{ bookedCount: 5, capacity: 8, trainingType: 'group' }]], () => [
      { id: 'purchase-1', bookingId: 'b1', slotId: 's1', memberId: 'm1' },
    ]);
    db.delete = jest.fn(() => ({ where: () => Promise.resolve() }));
    const { svc, notifications } = makeService(db);
    await svc.rejectCash('trainer-1', 'purchase-1');
    expect(notifications.enqueueAndProcess).not.toHaveBeenCalled();
  });

  // Late-cancelled by the member: rejecting the cash leaves the booking and its spend alone
  it('rejecting cash for a booking the member already cancelled deletes no mark or spend', async () => {
    let call = 0;
    const { db } = makeDb([], () => (call++ === 0 ? [{ id: 'purchase-1', bookingId: 'b1', slotId: 's1' }] : []));
    db.delete = jest.fn(() => ({ where: () => Promise.resolve() }));
    const { svc } = makeService(db);
    await svc.rejectCash('trainer-1', 'purchase-1');
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('rejecting cash with no booking (bought in «Мої покупки») touches only the purchase', async () => {
    const { db } = makeDb([]);
    const { svc } = makeService(db);
    await svc.rejectCash('trainer-1', 'purchase-1');
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('trainer purchase endpoints are admin-only (AdminGuard on the controller)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminPurchasesController) as unknown[];
    expect(guards).toContain(AdminGuard);
  });
});

describe('Trainer — money that came after the purchase ended', () => {
  it('lists such payments with what was bought, the amount and the payment number for a refund', async () => {
    const paidAt = new Date('2026-10-23T11:05:00Z');
    const { db } = makeDb([
      [
        {
          paymentId: 'pay-1',
          purchaseId: 'purchase-1',
          memberId: 'm1',
          displayName: 'Катя',
          amountUah: 250,
          liqpayPaymentId: '123456',
          paidAt,
        },
      ],
      [{ id: 'purchase-1', method: 'LIQPAY', status: 'CANCELLED', totalUah: 250, createdAt: paidAt }],
      [{ purchaseId: 'purchase-1', section: 'group', title: 'Разове відвідування', optionLabel: null, amountUah: 250 }],
    ]);
    const { svc } = makeService(db);
    expect(await svc.strayPayments('trainer-1')).toEqual([
      {
        paymentId: 'pay-1',
        memberId: 'm1',
        displayName: 'Катя',
        amountUah: 250,
        liqpayPaymentId: '123456',
        paidAt: paidAt.toISOString(),
        lines: [{ section: 'group', title: 'Разове відвідування', optionLabel: null, amountUah: 250 }],
      },
    ]);
  });

  it('«Розібрано» marks the payment handled by this trainer', async () => {
    const { db, sets } = makeDb([[{ handledAt: null }]]);
    const { svc } = makeService(db);
    await svc.markPaymentHandled('trainer-1', 'pay-1');
    expect(sets).toEqual([{ handledAt: NOW.toJSDate(), handledByAdminId: 'trainer-1' }]);
  });

  it("another trainer's client (or an ordinary payment): 404, nothing changed", async () => {
    const { db, sets } = makeDb([[]]);
    const { svc } = makeService(db);
    await expect(svc.markPaymentHandled('trainer-2', 'pay-1')).rejects.toThrow(NotFoundException);
    expect(sets).toEqual([]);
  });

  it('already handled (by anyone): 409', async () => {
    const { db } = makeDb([[{ handledAt: null }]], () => []);
    const { svc } = makeService(db);
    await expect(svc.markPaymentHandled('trainer-1', 'pay-1')).rejects.toThrow(ConflictException);
  });
});
