import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { sameSignature } from './payment-gateway.js';

/**
 * Signed links to a booking's payment page. The page opens in a browser (no Voyago session
 * there), so the link carries its own proof: the booking, the hold's expiry and where to return,
 * signed with a key derived from the server secret. The page only shows what to pay; payment
 * itself is proven by the provider, never by the link.
 */
@Injectable()
export class CheckoutTokens {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.key = createHmac('sha256', config.JWT_ACCESS_SECRET).update('voyago:checkout:v1').digest();
  }

  /** Accepts the app's own return addresses only; null for anything else or nothing. */
  checkReturnUrl(url: string | undefined | null): string | null {
    if (!url) return null;
    const web = new URL(this.config.APP_PUBLIC_URL).origin;
    const allowed =
      url.startsWith(`${web}/`) ||
      url.startsWith('voyago://') ||
      (this.config.NODE_ENV !== 'production' && url.startsWith('exp://'));
    if (!allowed) throw new BadRequestException('This return address is not allowed');
    return url;
  }

  checkoutUrl(bookingId: string, expiresAt: Date, returnUrl: string | null): string {
    const e = String(expiresAt.getTime());
    const r = returnUrl ?? '';
    const params = new URLSearchParams({ e, r, s: this.sign(bookingId, e, r) });
    return `${this.config.API_PUBLIC_URL}/api/v1/checkout/${bookingId}?${params.toString()}`;
  }

  /** The payment page for a subscription's first payment (signed separately from bookings). */
  subscriptionCheckoutUrl(
    subscriptionId: string,
    expiresAt: Date,
    returnUrl: string | null,
  ): string {
    const e = String(expiresAt.getTime());
    const r = returnUrl ?? '';
    const params = new URLSearchParams({ e, r, s: this.sign(`sub:${subscriptionId}`, e, r) });
    return `${this.config.API_PUBLIC_URL}/api/v1/checkout/subscriptions/${subscriptionId}?${params.toString()}`;
  }

  verifySubscription(subscriptionId: string, e: string, r: string, s: string): string | null {
    return this.verify(`sub:${subscriptionId}`, e, r, s);
  }

  /** The return address of a valid link (expiry is checked separately); throws otherwise. */
  verify(bookingId: string, e: string, r: string, s: string): string | null {
    if (!/^\d{10,16}$/.test(e) || !sameSignature(this.sign(bookingId, e, r), s)) {
      throw new BadRequestException('This payment link is not valid');
    }
    return r || null;
  }

  isExpired(e: string, now = Date.now()) {
    return Number(e) <= now;
  }

  private sign(bookingId: string, e: string, r: string) {
    return createHmac('sha256', this.key).update(`${bookingId}.${e}.${r}`).digest('base64url');
  }
}
