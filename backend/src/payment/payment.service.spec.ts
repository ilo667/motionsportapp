import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { liqpaySign, liqpayEncode, liqpayDecode, liqpayVerify, liqpayStatus } from './liqpay.helper';
import { PaymentService } from './payment.service';

jest.mock('./liqpay.helper', () => ({
  ...jest.requireActual('./liqpay.helper'),
  liqpayStatus: jest.fn(),
}));
const mockLiqpayStatus = liqpayStatus as jest.MockedFunction<typeof liqpayStatus>;

// ── LiqPay helper ──────────────────────────────────────────────────────────

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

// ── PaymentService ─────────────────────────────────────────────────────────

// `sets` records every update().set(...) payload so tests can assert resulting statuses
function makeDb(results: unknown[][] = []) {
  let idx = 0;
  const next = () => results[idx++] ?? [];
  const sets: Record<string, unknown>[] = [];

  function readLink(): any {
    const chain: any = { then: (r: (v: unknown) => void) => r(next()) };
    for (const m of ['from', 'innerJoin', 'where', 'for', 'orderBy', 'limit']) {
      chain[m] = jest.fn().mockImplementation(() => readLink());
    }
    return chain;
  }

  // Writes resolve to one affected row, so `.returning()` destructuring works
  function writeLink(): any {
    const chain: any = { then: (r: (v: unknown) => void) => r([{ id: 'new-booking-id' }]) };
    for (const m of ['where', 'values', 'onConflictDoNothing', 'returning']) {
      chain[m] = jest.fn().mockImplementation(() => writeLink());
    }
    chain.set = jest.fn().mockImplementation((v: Record<string, unknown>) => { sets.push(v); return writeLink(); });
    return chain;
  }

  const db: any = {
    select: jest.fn().mockImplementation(() => readLink()),
    insert: jest.fn().mockImplementation(() => writeLink()),
    update: jest.fn().mockImplementation(() => writeLink()),
    transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<unknown>) => cb(db)),
  };
  return { db, sets };
}

beforeEach(() => mockLiqpayStatus.mockReset());

function makeService(db: any) {
  process.env.LIQPAY_PUBLIC_KEY = 'pub_key';
  process.env.LIQPAY_PRIVATE_KEY = 'priv_key';
  process.env.FRONTEND_URL = 'https://test.example.com';
  process.env.LIQPAY_SERVER_URL = 'https://api.example.com/payments/liqpay/callback';
  return new PaymentService({ db } as any);
}

describe('PaymentService — createCheckout', () => {
  it('throws BadRequestException when keys are not configured', async () => {
    const { db } = makeDb();
    const svc = makeService(db);
    delete process.env.LIQPAY_PUBLIC_KEY;
    await expect(svc.createCheckout('slot-1', 'member-1')).rejects.toThrow(BadRequestException);
    process.env.LIQPAY_PUBLIC_KEY = 'pub_key';
  });

  it('throws NotFoundException when slot does not exist', async () => {
    const { db } = makeDb([[]]);
    const svc = makeService(db);
    await expect(svc.createCheckout('slot-x', 'member-1')).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException when slot is CANCELLED', async () => {
    const { db } = makeDb([[{ id: 'slot-1', status: 'CANCELLED', trainingType: 'індивідуальні', bookedCount: 0, capacity: 8, trainingDayId: 'day-1' }]]);
    const svc = makeService(db);
    await expect(svc.createCheckout('slot-1', 'member-1')).rejects.toThrow(ConflictException);
  });

  it('throws BadRequestException for групові slot', async () => {
    const { db } = makeDb([[{ id: 'slot-1', status: 'ACTIVE', trainingType: 'групові', bookedCount: 0, capacity: 8, trainingDayId: 'day-1' }]]);
    const svc = makeService(db);
    await expect(svc.createCheckout('slot-1', 'member-1')).rejects.toThrow('does not require payment');
  });
});

describe('PaymentService — handleCallback', () => {
  it('returns ok:false for invalid signature', async () => {
    const { db } = makeDb();
    const svc = makeService(db);
    const result = await svc.handleCallback('bad_data', 'bad_sig');
    expect(result).toEqual({ ok: false });
  });

  it('accepts sandbox status and marks booking PAID', async () => {
    const { db } = makeDb([
      [{ id: 'pay-1', bookingId: 'booking-1', status: 'PENDING' }],
    ]);
    const svc = makeService(db);

    const decoded = { order_id: 'mg-123-abc', status: 'sandbox', payment_id: 42 };
    const data = liqpayEncode(decoded);
    const sig = liqpaySign('priv_key', data);

    const result = await svc.handleCallback(data, sig);
    expect(result).toEqual({ ok: true });
    expect(db.update).toHaveBeenCalled();
  });

  it('ignores already-processed payment', async () => {
    const { db } = makeDb([
      [{ id: 'pay-1', bookingId: 'booking-1', status: 'PAID' }],
    ]);
    const svc = makeService(db);

    const decoded = { order_id: 'mg-123-abc', status: 'success' };
    const data = liqpayEncode(decoded);
    const sig = liqpaySign('priv_key', data);

    const result = await svc.handleCallback(data, sig);
    expect(result).toEqual({ ok: true });
    expect(db.update).not.toHaveBeenCalled();
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
  it('cancels booking and marks payment FAILED on failure status', async () => {
    const { db, sets } = makeDb([
      [{ id: 'pay-1', bookingId: 'booking-1', status: 'PENDING' }],
      [{ slotId: 'slot-1' }],
    ]);
    const svc = makeService(db);

    const data = liqpayEncode({ order_id: 'mg-1', status: 'failure', err_code: 'limit' });
    const result = await svc.handleCallback(data, liqpaySign('priv_key', data));

    expect(result).toEqual({ ok: true });
    expect(sets).toContainEqual(expect.objectContaining({ status: 'FAILED' }));
    expect(sets).toContainEqual(expect.objectContaining({ status: 'CANCELLED' }));
  });
});

describe('PaymentService — getStatus', () => {
  const pending = { id: 'pay-1', bookingId: 'booking-1', status: 'PENDING', createdAt: new Date('2026-10-21T19:00:00Z') };

  it('throws NotFoundException when order does not belong to member', async () => {
    const { db } = makeDb([[]]);
    await expect(makeService(db).getStatus('mg-1', 'member-2')).rejects.toThrow(NotFoundException);
  });

  it('returns stored status without asking LiqPay when not PENDING', async () => {
    const { db } = makeDb([[{ ...pending, status: 'PAID' }]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'PAID' });
    expect(mockLiqpayStatus).not.toHaveBeenCalled();
  });

  it('marks PAID when LiqPay reports success', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'success', order_id: 'mg-1' });
    const { db, sets } = makeDb([[pending]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'PAID' });
    expect(sets).toContainEqual(expect.objectContaining({ status: 'PAID' }));
  });

  it('cancels booking when LiqPay reports failure', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'failure', err_code: 'limit' });
    const { db, sets } = makeDb([[pending], [{ slotId: 'slot-1' }]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'FAILED' });
    expect(sets).toContainEqual(expect.objectContaining({ status: 'CANCELLED' }));
  });

  it('stays PENDING for non-final LiqPay status', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: '3ds_verify' });
    const { db, sets } = makeDb([[pending]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'PENDING', expiresAt: '2026-10-21T19:15:00.000Z' });
    expect(sets).toHaveLength(0);
  });

  // Real responses from LiqPay sandbox test cards (see CLAUDE.md → LiqPay rules)
  it.each([
    ['limit', 'Limit is exceeded', '4000000000000002'],
    ['9859', 'Insufficient funds', '4000000000009995'],
  ])('returns errCode=%s for a rejected attempt (try_again) and keeps booking', async (errCode, errDescription) => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'try_again', err_code: errCode, err_description: errDescription });
    const { db, sets } = makeDb([[pending]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'PENDING', errCode, expiresAt: '2026-10-21T19:15:00.000Z' });
    expect(sets).toHaveLength(0);
  });

  it('stays PENDING when LiqPay returns result=error (e.g. payment not started)', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'error', status: 'error', err_code: 'payment_not_found' });
    const { db, sets } = makeDb([[pending]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'PENDING', expiresAt: '2026-10-21T19:15:00.000Z' });
    expect(sets).toHaveLength(0);
  });

  it('stays PENDING when LiqPay is unreachable', async () => {
    mockLiqpayStatus.mockRejectedValue(new Error('timeout'));
    const { db, sets } = makeDb([[pending]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'PENDING', expiresAt: '2026-10-21T19:15:00.000Z' });
    expect(sets).toHaveLength(0);
  });
});

describe('PaymentService — expireStale', () => {
  const stale = { id: 'pay-1', bookingId: 'booking-1', orderId: 'mg-1' };

  it('marks PAID instead of expiring when LiqPay reports success (lost callback)', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'success' });
    const { db, sets } = makeDb([[stale]]);
    await expect(makeService(db).expireStale()).resolves.toEqual({ expired: 0 });
    expect(sets).toContainEqual(expect.objectContaining({ status: 'PAID' }));
    expect(sets).not.toContainEqual(expect.objectContaining({ status: 'EXPIRED' }));
  });

  it('does not expire when LiqPay is unreachable', async () => {
    mockLiqpayStatus.mockRejectedValue(new Error('timeout'));
    const { db, sets } = makeDb([[stale]]);
    await expect(makeService(db).expireStale()).resolves.toEqual({ expired: 0 });
    expect(sets).toHaveLength(0);
  });

  it('expires and frees the slot when payment was not completed', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'error', status: 'error', err_code: 'payment_not_found' });
    const { db, sets } = makeDb([[stale], [{ slotId: 'slot-1' }]]);
    await expect(makeService(db).expireStale()).resolves.toEqual({ expired: 1 });
    expect(sets).toContainEqual(expect.objectContaining({ status: 'EXPIRED' }));
    expect(sets).toContainEqual(expect.objectContaining({ status: 'CANCELLED' }));
  });
});

describe('PaymentService — resume PENDING checkout', () => {
  const slot = { id: 'slot-1', status: 'ACTIVE', trainingType: 'індивідуальні', bookedCount: 1, capacity: 8, trainingDayId: 'day-1' };
  const pending = { id: 'pay-1', bookingId: 'booking-1', orderId: 'mg-old' };

  it('issues a new order for the same booking instead of 409', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'error', status: 'error', err_code: 'payment_not_found' });
    const { db, sets } = makeDb([[slot], [pending]]);
    const result = await makeService(db).createCheckout('slot-1', 'member-1');

    expect(result).toHaveProperty('data');
    const orderId = liqpayDecode((result as { data: string }).data).order_id as string;
    expect(orderId).toMatch(/^mg-\d+-booking-/);
    expect(orderId).not.toBe('mg-old');
    expect(sets).toContainEqual(expect.objectContaining({ status: 'REPLACED' }));
    expect(sets).not.toContainEqual(expect.objectContaining({ bookedCount: expect.anything() }));
  });

  it('returns PAID without redirect when the previous attempt actually succeeded', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'success' });
    const { db, sets } = makeDb([[slot], [pending]]);
    await expect(makeService(db).createCheckout('slot-1', 'member-1')).resolves.toEqual({ status: 'PAID' });
    expect(sets).toContainEqual(expect.objectContaining({ status: 'PAID' }));
  });

  it('starts a fresh booking when the previous attempt failed', async () => {
    mockLiqpayStatus.mockResolvedValue({ result: 'ok', status: 'failure' });
    const { db, sets } = makeDb([[slot], [pending], [{ slotId: 'slot-1' }], [slot], []]);
    const result = await makeService(db).createCheckout('slot-1', 'member-1');

    expect(result).toHaveProperty('data');
    expect(sets).toContainEqual(expect.objectContaining({ status: 'FAILED' }));
    expect(db.insert).toHaveBeenCalled();
  });

  it('still returns 409 when the PENDING booking is on another slot', async () => {
    const { db } = makeDb([[slot], [], [slot], [{ id: 'booking-other' }]]);
    await expect(makeService(db).createCheckout('slot-1', 'member-1')).rejects.toThrow('already have an active booking');
    expect(mockLiqpayStatus).not.toHaveBeenCalled();
  });
});

describe('PaymentService — callback for a REPLACED attempt', () => {
  const replaced = { id: 'pay-old', bookingId: 'booking-1', status: 'REPLACED' };
  const callback = () => {
    const data = liqpayEncode({ order_id: 'mg-old', status: 'success' });
    return [data, liqpaySign('priv_key', data)] as const;
  };

  it('marks booking PAID when it still awaits payment', async () => {
    const { db, sets } = makeDb([[replaced], [{ status: 'ACTIVE', paymentStatus: 'PENDING' }]]);
    await makeService(db).handleCallback(...callback());
    expect(sets).toContainEqual(expect.objectContaining({ status: 'PAID' }));
    expect(sets).toContainEqual(expect.objectContaining({ paymentStatus: 'PAID' }));
  });

  it('does not touch a booking that is already paid (double payment → manual handling)', async () => {
    const { db, sets } = makeDb([[replaced], [{ status: 'ACTIVE', paymentStatus: 'PAID' }]]);
    await makeService(db).handleCallback(...callback());
    // Only the evidence is stored — no status / booking changes
    expect(sets).toEqual([expect.objectContaining({ rawCallback: expect.objectContaining({ status: 'success' }) })]);
    expect(sets[0]).not.toHaveProperty('status');
    expect(sets[0]).not.toHaveProperty('paymentStatus');
  });

  it('stores raw_callback when money arrives for an EXPIRED payment, without changing status', async () => {
    const { db, sets } = makeDb([[{ id: 'pay-old', bookingId: 'booking-1', status: 'EXPIRED' }]]);
    await makeService(db).handleCallback(...callback());
    expect(sets).toEqual([expect.objectContaining({ rawCallback: expect.objectContaining({ order_id: 'mg-old', status: 'success' }) })]);
    expect(sets[0]).not.toHaveProperty('status');
  });
});

describe('PaymentService — PAYMENT_EXPIRY_MINUTES', () => {
  afterEach(() => { delete process.env.PAYMENT_EXPIRY_MINUTES; });

  it('uses the configured expiry for expiresAt', async () => {
    process.env.PAYMENT_EXPIRY_MINUTES = '2';
    mockLiqpayStatus.mockResolvedValue({ result: 'error', status: 'error', err_code: 'payment_not_found' });
    const pending = { id: 'pay-1', bookingId: 'booking-1', status: 'PENDING', createdAt: new Date('2026-10-21T19:00:00Z') };
    const { db } = makeDb([[pending]]);
    await expect(makeService(db).getStatus('mg-1', 'member-1')).resolves.toEqual({ status: 'PENDING', expiresAt: '2026-10-21T19:02:00.000Z' });
  });
});

describe('PaymentService — LiqPay expired_date', () => {
  afterEach(() => { delete process.env.PAYMENT_EXPIRY_MINUTES; });

  it('passes expired_date equal to our expiry so LiqPay closes the order together with the booking', async () => {
    process.env.PAYMENT_EXPIRY_MINUTES = '15';
    mockLiqpayStatus.mockResolvedValue({ result: 'error', status: 'error', err_code: 'payment_not_found' });
    const slot = { id: 'slot-1', status: 'ACTIVE', trainingType: 'індивідуальні', bookedCount: 1, capacity: 8, trainingDayId: 'day-1' };
    const { db } = makeDb([[slot], [{ id: 'pay-1', bookingId: 'booking-1', orderId: 'mg-old' }]]);

    const before = Date.now();
    const result = await makeService(db).createCheckout('slot-1', 'member-1');
    const expired = liqpayDecode((result as { data: string }).data).expired_date as string;

    expect(expired).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const expiredMs = new Date(expired.replace(' ', 'T') + 'Z').getTime();
    expect(expiredMs).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 1000);
    expect(expiredMs).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
  });
});
