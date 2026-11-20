import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes as base64url (43 characters): refresh tokens and email links. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens with 256 bits of entropy need no salt; SHA-256 is enough to make a stolen table useless. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
