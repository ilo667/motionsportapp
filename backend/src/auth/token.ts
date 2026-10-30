import * as crypto from 'crypto';

// Session cookie and invite link token; the DB keeps only its SHA-256
export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Constant time, so timing doesn't leak how much of a guess matched. Length check first: timingSafeEqual throws
export function safeEqual(expected: string, actual: string | undefined): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual ?? '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
