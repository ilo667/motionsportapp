import * as crypto from 'crypto';

export function liqpaySign(privateKey: string, data: string): string {
  return crypto.createHash('sha1').update(privateKey + data + privateKey).digest('base64');
}

export function liqpayEncode(params: object): string {
  return Buffer.from(JSON.stringify(params)).toString('base64');
}

export function liqpayDecode(data: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(data, 'base64').toString('utf-8')) as Record<string, unknown>;
}

export function liqpayVerify(privateKey: string, data: string, signature: string): boolean {
  return liqpaySign(privateKey, data) === signature;
}
