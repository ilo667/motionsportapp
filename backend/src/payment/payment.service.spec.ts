import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { liqpaySign, liqpayEncode, liqpayDecode, liqpayVerify, liqpayStatus } from './liqpay.helper';
import { PaymentService } from './payment.service';

jest.mock('./liqpay.helper', () => ({
  ...jest.requireActual('./liqpay.helper'),
  liqpayStatus: jest.fn(),
}));
const mockLiqpayStatus = liqpayStatus as jest.MockedFunction<typeof liqpayStatus>;

describe('liqpay helper', () => {
  const privateKey = 'test_private_key';
  const params = { version: 3, action: 'pay', amount: 700, currency: 'UAH' };

  it('encodes and decodes params symmetrically', () => {
    const data = liqpayEncode(params);
    expect(liqpayDecode(data)).toEqual(params);
  });

  it('sign produces base64 string', () => {
    const data = liqpayEncode(params);
    const sig = liqpaySign(privateKey, data);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
  });

  it('verify returns true for correct signature', () => {
    const data = liqpayEncode(params);
    const sig = liqpaySign(privateKey, data);
    expect(liqpayVerify(privateKey, data, sig)).toBe(true);
  });

  it('verify returns false for tampered data', () => {
    const data = liqpayEncode(params);
    const sig = liqpaySign(privateKey, data);
    const tampered = liqpayEncode({ ...params, amount: 1 });
    expect(liqpayVerify(privateKey, tampered, sig)).toBe(false);
  });

  it('verify returns false for wrong private key', () => {
    const data = liqpayEncode(params);
    const sig = liqpaySign(privateKey, data);
    expect(liqpayVerify('wrong_key', data, sig)).toBe(false);
  });

  it('verify returns false (does not throw) for signature of different length', () => {
    const data = liqpayEncode(params);
    expect(liqpayVerify(privateKey, data, 'short')).toBe(false);
  });

  it('verify returns false for empty or missing signature', () => {
    const data = liqpayEncode(params);
    expect(liqpayVerify(privateKey, data, '')).toBe(false);
    expect(liqpayVerify(privateKey, data, undefined as unknown as string)).toBe(false);
  });
});

// `sets` records every update().set() payload. `writeResult` returning [] simulates a lost compare-and-set
function makeDb(
  results: unknown[][] = [],
  writeResult: (set?: Record<string, unknown>) => unknown[] = () => [{ id: 'row' }],
) {
  let idx = 0;
  const next = () => results[idx++] ?? [];
  const sets: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];

  function readLink(): any {
    const chain: any = { then: (r: (v: unknown) => void) => r(next()) };
    for (const m of ['from', 'innerJoin', 'where', 'for', 'orderBy', 'limit']) {
      chain[m] = jest.fn().mockImplementation(() => readLink());
    }
    return chain;
  }

  function writeLink(payload?: Record<string, unknown>): any {
    const chain: any = { then: (r: (v: unknown) => void) => r(writeResult(payload)) };
    for (const m of ['where', 'onConflictDoNothing', 'returning']) {
      chain[m] = jest.fn().mockImplementation(() => writeLink(payload));
    }
    chain.values = jest.fn().mockImplementation((v: Record<string, unknown>) => {
      inserts.push(v);
      return writeLink(payload);
    });
    chain.set = jest.fn().mockImplementation((v: Record<string, unknown>) => {
      sets.push(v);
      return writeLink(v);
    });
    return chain;
  }

  const db: any = {
    select: jest.fn().mockImplementation(() => readLink()),
    insert: jest.fn().mockImplementation(() => writeLink()),
    update: jest.fn().mockImplementation(() => writeLink()),
    transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<unknown>) => cb(db)),
  };
  return { db, sets, inserts };
}

beforeEach(() => mockLiqpayStatus.mockReset());

// Tells the purchase update (decidedAt) from the payment update (liqpayPaymentId)
const purchasePaid = (v: Record<string, unknown>) => v.status === 'PAID' && 'decidedAt' in v;
const paymentPaid = (v: Record<string, unknown>) => v.status === 'PAID' && 'liqpayPaymentId' in v;

function makeService(db: any) {
  process.env.LIQPAY_PUBLIC_KEY = 'pub_key';
  process.env.LIQPAY_PRIVATE_KEY = 'priv_key';
  process.env.FRONTEND_URL = 'https://test.example.com';
  process.env.LIQPAY_SERVER_URL = 'https://api.example.com/payments/liqpay/callback';
  const entitlements = { activate: jest.fn().mockResolvedValue(undefined) };
  const svc = new PaymentService({ db } as any, { now: () => DateTime.now() }, entitlements as any);
  return Object.assign(svc, { mockEntitlements: entitlements });
}

// checkoutPurchase reads: purchase, lines, then the PENDING payment
const PURCHASE = [{ id: 'purchase-1', status: 'PENDING', method: 'LIQPAY', totalUah: 3600 }];
const LINES = [[{ title: 'Персональне', optionLabel: '8 тренувань' }]];

describe('PaymentService — checkoutPurchase', () => {
  it('throws BadRequestException when keys are not configured', async () => {
    const { db } = makeDb();
    const svc = makeService(db);
    delete process.env.LIQPAY_PUBLIC_KEY;
    await expect(svc.checkoutPurchase('purchase-1', 'member-1')).rejects.toThrow(BadRequestException);
    process.env.LIQPAY_PUBLIC_KEY = 'pub_key';
  });

  it("404 for someone else's purchase (or a missing one)", async () => {
    const { db } = makeDb([[]]);
    await expect(makeService(db).checkoutPurchase('purchase-1', 'member-2')).rejects.toThrow(NotFoundException);
  });

  it('404 for a cash purchase', async () => {
    const { db } = makeDb([[{ ...PURCHASE[0], method: 'CASH' }]]);
    await expect(makeService(db).checkoutPurchase('purchase-1', 'member-1')).rejects.toThrow(NotFoundException);
  });

  it('409 when the purchase no longer awaits payment', async () => {
    const { db } = makeDb([[{ ...PURCHASE[0], status: 'CANCELLED' }]]);
    await expect(makeService(db).checkoutPurchase('purchase-1', 'member-1')).rejects.toThrow(ConflictException);
  });

  it('charges the purchase total with a description of what is bought', async () => {
    const { db, inserts } = makeDb([PURCHASE, ...LINES, []]);
    const result = await makeService(db).checkoutPurchase('purchase-1', 'member-1');
    const params = liqpayDecode((result as { data: string }).data);
    expect(params).toMatchObject({
      amount: 3600,
      currency: 'UAH',
      description: 'Motion Gym: Персональне · 8 тренувань',
    });
    expect(params).not.toHaveProperty('sandbox');
    expect(inserts).toContainEqual(
      expect.objectContaining({ purchaseId: 'purchase-1', amount: 3600, status: 'PENDING' }),
    );
    expect(mockLiqpayStatus).not.toHaveBeenCalled();
  });
});

describe('PaymentService — handleCallback', () => {
  it('returns ok:false for invalid signature', async () => {
    const { db } = makeDb();
    const svc = makeService(db);
    const result = await svc.handleCallback('bad_data', 'bad_sig');
    expect(result).toEqual({ ok: false });
  });

  it('accepts sandbox status, marks the purchase PAID and activates it once', async () => {
    const { db, sets } = makeDb([[{ id: 'pay-1', purchaseId: 'purchase-1', status: 'PENDING' }]]);
    const svc = makeService(db);

    const decoded = { order_id: 'mg-123-abc', status: 'sandbox', payment_id: 42 };
    const data = liqpayEncode(decoded);
    const sig = liqpaySign('priv_key', data);

    const result = await svc.handleCallback(data, sig);
    expect(result).toEqual({ ok: true });
    expect(sets.filter(purchasePaid)).toHaveLength(1);
    expect(svc.mockEntitlements.activate).toHaveBeenCalledTimes(1);
    expect(svc.mockEntitlements.activate).toHaveBeenCalledWith(db, 'purchase-1');
  });

  it('ignores already-processed payment', async () => {
    const { db } = makeDb([[{ id: 'pay-1', purchaseId: 'purchase-1', status: 'PAID' }]]);
    const svc = makeService(db);

    const decoded = { order_id: 'mg-123-abc', status: 'success' };
    const data = liqpayEncode(decoded);
    const sig = liqpaySign('priv_key', data);

    const result = await svc.handleCallback(data, sig);
    expect(result).toEqual({ ok: true });
    expect(db.update).not.toHaveBeenCalled();
    expect(svc.mockEntitlements.activate).not.toHaveBeenCalled();
  });

  it('returns ok:true when payment not found', async () => {
    const { db } = makeDb([[]]); // empty → payment not found
    const svc = makeService(db);

    const decoded = { order_id: 'unknown-order', status: 'success' };
    const data = liqpayEncode(decoded);
    const sig = liqpaySign('priv_key', data);

    const result = await svc.handleCallback(data, sig);
    expect(result).toEqual({ ok: true });
  });
});

describe('PaymentService — handleCallback failure', () => {
  it('ends the purchase and marks payment FAILED on failure status', async () => {
    const { db, sets } = makeDb([[{ id: 'pay-1', purchaseId: 'purchase-1', status: 'PENDING' }]]);
    const svc = makeService(db);

    const data = liqpayEncode({ order_id: 'mg-1', status: 'failure', err_code: 'limit' });
    const result = await svc.handleCallback(data, liqpaySign('priv_key', data));

    expect(result).toEqual({ ok: true });
    expect(sets).toContainEqual(expect.objectContaining({ status: 'FAILED' }));
    expect(sets).toContainEqual(expect.objectContaining({ status: 'FAILED', decidedAt: expect.any(Date) }));
    expect(svc.mockEntitlements.activate).not.toHaveBeenCalled();
  });
});

describe('PaymentService — getStatus', () => {
  const pending = {
    id: 'pay-1',
    purchaseId: 'purchase-1',
    status: 'PENDING',
    createdAt: new Date('2026-10-21T19:00:00Z'),
  };

  it('throws NotFoundException when order does not belong to member', async () => {
    const { db } = makeDb([[]]);
    await expect(makeService(db).getStatus('mg-1', 'member-2')).rejects.toThrow(NotFoundException);
  });

  it('returns stored status without asking LiqPay when not PENDING', async () => {
    const { db } = makeDb([[{ ...pending, status: 'PAID' }]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'PAID' });
    expect(mockLiqpayStatus).not.toHaveBeenCalled();
  });

  it('a paid group pass bought from «Записатися» says whether the slot got booked', async () => {
    const { db } = makeDb([[{ ...pending, status: 'PAID', slotId: 'slot-1', bookingId: 'b1' }]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'PAID', booked: true });
    const other = makeDb([[{ ...pending, status: 'PAID', slotId: 'slot-1', bookingId: null }]]);
    await expect(makeService(other.db).getStatus('mg-1', 'member-1')).resolves.toEqual({
      status: 'PAID',
      booked: false,
    });
  });

  it('marks PAID when LiqPay reports success', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'success', order_id: 'mg-1' });
    const { db, sets } = makeDb([[pending]]);
    const svc = makeService(db);
    await expect(svc.getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'PAID' });
    expect(sets.filter(paymentPaid)).toHaveLength(1);
    expect(svc.mockEntitlements.activate).toHaveBeenCalledTimes(1);
  });

  it('ends the purchase when LiqPay reports failure', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'failure', err_code: 'limit' });
    const { db, sets } = makeDb([[pending]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'FAILED' });
    expect(sets).toContainEqual(expect.objectContaining({ status: 'FAILED', decidedAt: expect.any(Date) }));
  });

  it('stays PENDING for non-final LiqPay status', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: '3ds_verify' });
    const { db, sets } = makeDb([[pending]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({
      status: 'PENDING',
      expiresAt: '2026-10-21T19:15:00.000Z',
    });
    expect(sets).toHaveLength(0);
  });

  // Real LiqPay sandbox responses for these test cards
  it.each([
    ['limit', 'Limit is exceeded', '4000000000000002'],
    ['9859', 'Insufficient funds', '4000000000009995'],
  ])(
    'returns errCode=%s for a rejected attempt (try_again) and keeps the purchase',
    async (errCode, errDescription) => {
      mockLiqpayStatus.mockResolvedValue({
        result: 'ok',
        status: 'try_again',
        err_code: errCode,
        err_description: errDescription,
      });
      const { db, sets } = makeDb([[pending]]);
      await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({
        status: 'PENDING',
        errCode,
        expiresAt: '2026-10-21T19:15:00.000Z',
      });
      expect(sets).toHaveLength(0);
    },
  );

  it('stays PENDING when LiqPay returns result=error (e.g. payment not started)', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'error', status: 'error', err_code: 'payment_not_found' });
    const { db, sets } = makeDb([[pending]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({
      status: 'PENDING',
      expiresAt: '2026-10-21T19:15:00.000Z',
    });
    expect(sets).toHaveLength(0);
  });

  it('stays PENDING when LiqPay is unreachable', async () => {
    mockLiqpayStatus.mockRejectedValue(new Error('timeout'));
    const { db, sets } = makeDb([[pending]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({
      status: 'PENDING',
      expiresAt: '2026-10-21T19:15:00.000Z',
    });
    expect(sets).toHaveLength(0);
  });
});

describe('PaymentService — expireStale', () => {
  const stale = { id: 'pay-1', purchaseId: 'purchase-1', orderId: 'mg-1' };

  it('marks PAID instead of expiring when LiqPay reports success (lost callback)', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'success' });
    const { db, sets } = makeDb([[stale]]);
    const svc = makeService(db);
    await expect(svc.expireStale()).resolves.toEqual({ expired: 0 });
    expect(sets.filter(paymentPaid)).toHaveLength(1);
    expect(sets).not.toContainEqual(expect.objectContaining({ status: 'EXPIRED' }));
    expect(svc.mockEntitlements.activate).toHaveBeenCalledTimes(1);
  });

  it('does not expire when LiqPay is unreachable', async () => {
    mockLiqpayStatus.mockRejectedValue(new Error('timeout'));
    const { db, sets } = makeDb([[stale]]);
    await expect(makeService(db).expireStale()).resolves.toEqual({ expired: 0 });
    expect(sets).toHaveLength(0);
  });

  it('expires the payment and the purchase when it was not completed', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'error', status: 'error', err_code: 'payment_not_found' });
    const { db, sets } = makeDb([[stale]]);
    await expect(makeService(db).expireStale()).resolves.toEqual({ expired: 1 });
    expect(sets).toContainEqual(expect.objectContaining({ status: 'EXPIRED', updatedAt: expect.any(Date) }));
    expect(sets).toContainEqual(expect.objectContaining({ status: 'EXPIRED', decidedAt: expect.any(Date) }));
  });

  it('asks LiqPay about all stale payments at once, not one after another', async () => {
    // Every status call stays unanswered until all of them have started
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockLiqpayStatus.mockImplementation(async () => {
      if (mockLiqpayStatus.mock.calls.length === 2) release();
      await gate;
      return { result: 'error', status: 'error', err_code: 'payment_not_found' };
    });
    const { db } = makeDb([[stale, { id: 'pay-2', purchaseId: 'purchase-2', orderId: 'mg-2' }]]);
    await expect(makeService(db).expireStale()).resolves.toEqual({ expired: 2 });
    expect(mockLiqpayStatus).toHaveBeenCalledTimes(2);
  });
});

describe('PaymentService — resume PENDING checkout', () => {
  const pending = { id: 'pay-1', purchaseId: 'purchase-1', orderId: 'mg-old' };

  it('issues a new order for the same purchase instead of 409', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'error', status: 'error', err_code: 'payment_not_found' });
    const { db, sets, inserts } = makeDb([PURCHASE, ...LINES, [pending]]);
    const result = await makeService(db).checkoutPurchase('purchase-1', 'member-1');

    expect(result).toHaveProperty('data');
    const orderId = liqpayDecode((result as { data: string }).data).order_id as string;
    expect(orderId).toMatch(/^mg-\d+-purchase/);
    expect(orderId).not.toBe('mg-old');
    expect(sets).toContainEqual(expect.objectContaining({ status: 'REPLACED' }));
    expect(inserts).toContainEqual(expect.objectContaining({ purchaseId: 'purchase-1', orderId, amount: 3600 }));
  });

  it('returns PAID without redirect when the previous attempt actually succeeded', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'success' });
    const { db, sets } = makeDb([PURCHASE, ...LINES, [pending]]);
    const svc = makeService(db);
    await expect(svc.checkoutPurchase('purchase-1', 'member-1')).resolves.toEqual({ status: 'PAID' });
    expect(sets.filter(purchasePaid)).toHaveLength(1);
    expect(svc.mockEntitlements.activate).toHaveBeenCalledTimes(1);
  });

  it('409 when the previous attempt failed: the purchase is over, the member starts a new one', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'failure' });
    const { db, sets } = makeDb([PURCHASE, ...LINES, [pending]]);
    await expect(makeService(db).checkoutPurchase('purchase-1', 'member-1')).rejects.toThrow(ConflictException);
    expect(sets).toContainEqual(expect.objectContaining({ status: 'FAILED', decidedAt: expect.any(Date) }));
  });
});

describe('PaymentService — callback for a REPLACED attempt', () => {
  const replaced = { id: 'pay-old', purchaseId: 'purchase-1', status: 'REPLACED' };
  const callback = () => {
    const data = liqpayEncode({ order_id: 'mg-old', status: 'success' });
    return [data, liqpaySign('priv_key', data)] as const;
  };

  it('pays the purchase when it still awaits payment (old LiqPay tab)', async () => {
    const { db, sets } = makeDb([[replaced], [{ status: 'PENDING' }]]);
    const svc = makeService(db);
    await svc.handleCallback(...callback());
    expect(sets.filter(paymentPaid)).toHaveLength(1);
    expect(sets.filter(purchasePaid)).toHaveLength(1);
    expect(svc.mockEntitlements.activate).toHaveBeenCalledTimes(1);
  });

  it('does not touch a purchase that is already paid (double payment → manual handling)', async () => {
    const { db, sets } = makeDb([[replaced], [{ status: 'PAID' }]]);
    const svc = makeService(db);
    await svc.handleCallback(...callback());
    // Only the payload is stored: no status change, nothing activated
    expect(sets).toEqual([expect.objectContaining({ rawCallback: expect.objectContaining({ status: 'success' }) })]);
    expect(sets[0]).not.toHaveProperty('status');
    expect(svc.mockEntitlements.activate).not.toHaveBeenCalled();
  });

  it('stores raw_callback when money arrives for an EXPIRED payment, without changing status', async () => {
    const { db, sets } = makeDb([[{ id: 'pay-old', purchaseId: 'purchase-1', status: 'EXPIRED' }]]);
    await makeService(db).handleCallback(...callback());
    expect(sets).toEqual([
      expect.objectContaining({ rawCallback: expect.objectContaining({ order_id: 'mg-old', status: 'success' }) }),
    ]);
    expect(sets[0]).not.toHaveProperty('status');
  });
});

describe('PaymentService — refund of a paid payment', () => {
  it('keeps the reversed callback apart, changes no status', async () => {
    const { db, sets } = makeDb([[{ id: 'pay-1', purchaseId: 'purchase-1', status: 'PAID' }]]);
    const svc = makeService(db);
    const data = liqpayEncode({ order_id: 'mg-1', status: 'reversed' });
    await expect(svc.handleCallback(data, liqpaySign('priv_key', data))).resolves.toEqual({ ok: true });
    expect(sets).toEqual([
      expect.objectContaining({ refundCallback: expect.objectContaining({ order_id: 'mg-1', status: 'reversed' }) }),
    ]);
    expect(sets[0]).not.toHaveProperty('status');
    expect(sets[0]).not.toHaveProperty('rawCallback');
    expect(svc.mockEntitlements.activate).not.toHaveBeenCalled();
  });
});

describe('PaymentService — money for a purchase that no longer awaits it', () => {
  it('success on a PENDING payment of a cancelled purchase: nothing activated, evidence saved, needs manual handling', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // Payment CAS wins, but the member cancelled the purchase meanwhile
    const { db, sets } = makeDb(
      [[{ id: 'pay-1', purchaseId: 'purchase-1', status: 'PENDING' }], [{ status: 'PENDING' }]],
      (set) => (set && purchasePaid(set) ? [] : [{ id: 'row' }]),
    );
    const svc = makeService(db);
    const data = liqpayEncode({ order_id: 'mg-1', status: 'success' });
    await expect(svc.handleCallback(data, liqpaySign('priv_key', data))).resolves.toEqual({ ok: true });

    expect(svc.mockEntitlements.activate).not.toHaveBeenCalled();
    expect(sets).toContainEqual(
      expect.objectContaining({ rawCallback: expect.objectContaining({ status: 'success' }) }),
    );
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('needs manual handling'));
    errorLog.mockRestore();
  });
});

describe('PaymentService — expiry', () => {
  it('a pending payment expires 15 minutes after it was created', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'error', status: 'error', err_code: 'payment_not_found' });
    const pending = {
      id: 'pay-1',
      purchaseId: 'purchase-1',
      status: 'PENDING',
      createdAt: new Date('2026-10-21T19:00:00Z'),
    };
    const { db } = makeDb([[pending]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({
      status: 'PENDING',
      expiresAt: '2026-10-21T19:15:00.000Z',
    });
  });
});

describe('PaymentService — LiqPay expired_date', () => {
  it('passes expired_date equal to our expiry so LiqPay closes the order together with the purchase', async () => {
    const { db } = makeDb([PURCHASE, ...LINES, []]);

    const before = Date.now();
    const result = await makeService(db).checkoutPurchase('purchase-1', 'member-1');
    const expired = liqpayDecode((result as { data: string }).data).expired_date as string;

    expect(expired).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const expiredMs = new Date(expired.replace(' ', 'T') + 'Z').getTime();
    expect(expiredMs).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 1000);
    expect(expiredMs).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
  });
});

describe('PaymentService — concurrent transitions (compare-and-set)', () => {
  const stale = { id: 'pay-1', purchaseId: 'purchase-1', orderId: 'mg-1' };
  const purchaseEnds = (sets: Record<string, unknown>[]) => sets.filter((v) => 'decidedAt' in v).length;

  it('expiring ends the purchase exactly once', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'error', status: 'error', err_code: 'payment_not_found' });
    const { db, sets } = makeDb([[stale]]);
    await expect(makeService(db).expireStale()).resolves.toEqual({ expired: 1 });
    expect(purchaseEnds(sets)).toBe(1);
  });

  it('two simultaneous expireStale runs end the purchase only once', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'error', status: 'error', err_code: 'payment_not_found' });
    // Postgres semantics: only the first UPDATE payments … WHERE status = 'PENDING' gets the row
    let paymentClaimed = false;
    const shared = makeDb([[stale], [stale]], (set) => {
      if (set?.status === 'EXPIRED' && 'updatedAt' in set) {
        if (paymentClaimed) return [];
        paymentClaimed = true;
      }
      return [{ id: 'row' }];
    });
    const svc = makeService(shared.db);

    const [a, b] = await Promise.all([svc.expireStale(), svc.expireStale()]);

    expect(a.expired + b.expired).toBe(1);
    expect(purchaseEnds(shared.sets)).toBe(1);
  });

  it('a failure callback after the payment was already expired changes nothing', async () => {
    const { db, sets } = makeDb(
      [[{ id: 'pay-1', purchaseId: 'purchase-1', status: 'PENDING' }], [{ status: 'EXPIRED' }]],
      (set) => (set?.status === 'FAILED' ? [] : [{ id: 'row' }]),
    );
    const data = liqpayEncode({ order_id: 'mg-1', status: 'failure' });
    await expect(makeService(db).handleCallback(data, liqpaySign('priv_key', data))).resolves.toEqual({ ok: true });
    expect(purchaseEnds(sets)).toBe(0);
  });

  it('status check reports the real status when another request already marked it PAID', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'success' });
    const pending = {
      id: 'pay-1',
      purchaseId: 'purchase-1',
      status: 'PENDING',
      createdAt: new Date('2026-10-21T19:00:00Z'),
    };
    const { db, sets } = makeDb([[pending], [{ status: 'PAID' }]], (set) =>
      set && paymentPaid(set) ? [] : [{ id: 'row' }],
    );
    const svc = makeService(db);
    await expect(svc.getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'PAID' });
    expect(sets.filter(purchasePaid)).toHaveLength(0); // purchase untouched by the loser
    expect(svc.mockEntitlements.activate).not.toHaveBeenCalled();
  });

  it('callback and status check racing on one order activate the purchase once', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'success' });
    let paymentClaimed = false;
    const pending = { id: 'pay-1', purchaseId: 'purchase-1', status: 'PENDING', createdAt: new Date() };
    const shared = makeDb([[pending], [pending], [{ status: 'PAID' }], [{ status: 'PAID' }]], (set) => {
      if (set && paymentPaid(set)) {
        if (paymentClaimed) return [];
        paymentClaimed = true;
      }
      return [{ id: 'row' }];
    });
    const svc = makeService(shared.db);
    const data = liqpayEncode({ order_id: 'mg-1', status: 'success' });

    await Promise.all([svc.handleCallback(data, liqpaySign('priv_key', data)), svc.getStatus('mg-1', 'member-1')]);

    expect(svc.mockEntitlements.activate).toHaveBeenCalledTimes(1);
    expect(shared.sets.filter(purchasePaid)).toHaveLength(1);
  });
});
