import * as crypto from 'crypto';

// Opaque random token (session cookie, trainer invite link); the DB keeps only its SHA-256
export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}
