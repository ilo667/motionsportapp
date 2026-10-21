import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { liqpaySign, liqpayEncode, liqpayDecode, liqpayVerify } from './liqpay.helper';
import { PaymentService } from './payment.service';

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
});

// ── PaymentService ─────────────────────────────────────────────────────────

function makeDb(results: unknown[][] = []) {
  let idx = 0;
  const next = () => results[idx++] ?? [];

  function readLink(): any {
    const chain: any = { then: (r: (v: unknown) => void) => r(next()) };
    for (const m of ['from', 'where', 'for', 'orderBy', 'limit']) {
      chain[m] = jest.fn().mockImplementation(() => readLink());
    }
    return chain;
  }

  function writeLink(): any {
    const chain: any = { then: (r: (v: void) => void) => r() };
    for (const m of ['set', 'where', 'values', 'onConflictDoNothing', 'returning']) {
      chain[m] = jest.fn().mockImplementation(() => writeLink());
    }
    return chain;
  }

  const db: any = {
    select: jest.fn().mockImplementation(() => readLink()),
    insert: jest.fn().mockImplementation(() => writeLink()),
    update: jest.fn().mockImplementation(() => writeLink()),
    transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<unknown>) => cb(db)),
  };
  return { db };
}

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
