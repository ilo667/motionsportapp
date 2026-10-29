import * as crypto from 'crypto';

// Opaque random token (session cookie, trainer invite link); the DB keeps only its SHA-256
export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Compares a secret (signature, cron secret) in constant time, so the response time doesn't reveal how much of a guess
// matched. timingSafeEqual throws on different lengths, hence the length check first
export function safeEqual(expected: string, actual: string | undefined): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual ?? '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
