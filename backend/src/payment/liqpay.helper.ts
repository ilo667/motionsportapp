import * as crypto from 'crypto';

export function liqpaySign(privateKey: string, data: string): string {
  return crypto
    .createHash('sha1')
    .update(privateKey + data + privateKey)
    .digest('base64');
}

export function liqpayEncode(params: object): string {
  return Buffer.from(JSON.stringify(params)).toString('base64');
}

export function liqpayDecode(data: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(data, 'base64').toString('utf-8')) as Record<string, unknown>;
}

export function liqpayVerify(privateKey: string, data: string, signature: string): boolean {
  const expected = Buffer.from(liqpaySign(privateKey, data));
  const actual = Buffer.from(signature ?? '');
  // timingSafeEqual throws on length mismatch, so check the length first
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const LIQPAY_API_URL = 'https://www.liqpay.ua/api/request';

// Server-to-server status check: https://www.liqpay.ua/uk/doc/api/information/status_payment
// Throws on network error / timeout — callers must treat that as "unknown", not as failure.
export async function liqpayStatus(
  publicKey: string,
  privateKey: string,
  orderId: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const data = liqpayEncode({ version: 3, public_key: publicKey, action: 'status', order_id: orderId });
  const res = await fetch(LIQPAY_API_URL, {
    method: 'POST',
    body: new URLSearchParams({ data, signature: liqpaySign(privateKey, data) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`LiqPay status API returned ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}
