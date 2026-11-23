import { Body, Controller, Get, Logger, Param, Post, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { formatPaise, UuidSchema } from '@voyago/shared';
import { type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Public } from '../common/auth/public.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { PrismaService } from '../database/prisma.service.js';
import { CheckoutTokens } from './checkout-tokens.js';
import { PaymentEventsService } from './payment-events.service.js';
import { type GatewayPayment, PaymentGateway } from './payment-gateway.js';
import { PaymentsService } from './payments.service.js';

const idPipe = new ZodValidationPipe(UuidSchema);

type LinkQuery = { e?: string; r?: string; s?: string };

/** What the provider's checkout posts back. Field names are Razorpay's. */
type CallbackBody = Record<string, string | undefined>;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A small, self-contained page; nothing on it comes from another origin except the provider. */
export function page(title: string, body: string, nonce: string, script = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Voyago</title>
<style nonce="${nonce}">
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:32px 16px;background:#f6f7f9;color:#1b1f24}
main{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px}p{line-height:1.5;margin:8px 0}.total{font-size:28px;font-weight:700;margin:16px 0}
.muted{color:#5b6470;font-size:14px}button,a.button{display:block;width:100%;box-sizing:border-box;text-align:center;padding:14px;border:0;border-radius:8px;background:#0b6e4f;color:#fff;font-size:16px;font-weight:600;text-decoration:none;cursor:pointer;margin-top:16px}
a.button.secondary{background:transparent;color:inherit;border:1px solid #c5cbd3}
@media (prefers-color-scheme:dark){body{background:#111417;color:#e8eaed}main{background:#1b1f24;box-shadow:none}.muted{color:#a0a8b2}}
</style></head><body><main>${body}</main>${script}</body></html>`;
}

/**
 * The hosted payment page and the provider's return to it. The app opens the page in a browser
 * from a signed link; the page runs the provider's checkout, which posts back here. A return is
 * only a hint: the booking is confirmed from the provider's own record of the payment, fetched
 * by the server, and only when it matches the booking's amount and currency.
 */
@ApiExcludeController()
@Public()
@Controller('checkout')
export class CheckoutController {
  private readonly logger = new Logger(CheckoutController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: CheckoutTokens,
    private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
    private readonly events: PaymentEventsService,
  ) {}

  @Get(':id')
  async show(@Param('id', idPipe) id: string, @Query() query: LinkQuery, @Res() res: Response) {
    const nonce = randomBytes(16).toString('base64');
    let returnUrl: string | null;
    try {
      returnUrl = this.tokens.verify(id, query.e ?? '', query.r ?? '', query.s ?? '');
    } catch {
      return this.send(
        res,
        400,
        nonce,
        page(
          'Link not valid',
          '<h1>This payment link is not valid</h1><p>Go back to the app and try again.</p>',
          nonce,
        ),
      );
    }
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      select: {
        status: true,
        seats: true,
        totalAmountPaise: true,
        currency: true,
        expiresAt: true,
        package: { select: { title: true, operator: { select: { displayName: true } } } },
        payments: {
          where: { provider: this.gateway.name },
          select: { providerOrderId: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    const back = returnUrl
      ? `<a class="button" href="${escapeHtml(this.withResult(returnUrl, id, 'cancelled'))}">Back to Voyago</a>`
      : '';
    if (!booking) {
      return this.send(res, 404, nonce, page('Not found', '<h1>Booking not found</h1>', nonce));
    }
    if (booking.status === 'CONFIRMED' || booking.status === 'COMPLETED') {
      const done = returnUrl
        ? `<a class="button" href="${escapeHtml(this.withResult(returnUrl, id, 'paid'))}">Back to Voyago</a>`
        : '';
      return this.send(
        res,
        200,
        nonce,
        page(
          'Already paid',
          `<h1>This booking is paid</h1><p>Nothing more to do.</p>${done}`,
          nonce,
        ),
      );
    }
    const orderId = booking.payments[0]?.providerOrderId;
    const expired =
      booking.status !== 'PENDING_PAYMENT' ||
      !booking.expiresAt ||
      booking.expiresAt.getTime() <= Date.now() ||
      this.tokens.isExpired(query.e ?? '0');
    if (expired || !orderId || !this.gateway.enabled) {
      return this.send(
        res,
        410,
        nonce,
        page(
          'Hold ended',
          `<h1>This hold has ended</h1><p>The places are no longer held for you. Start a new booking in the app.</p>${back}`,
          nonce,
        ),
      );
    }

    const callback = new URL(
      `${this.tokens.checkoutUrl(id, new Date(Number(query.e)), returnUrl)}`,
    );
    callback.pathname = `${callback.pathname}/razorpay`;
    const options = {
      key: this.gateway.publicKey,
      order_id: orderId,
      amount: booking.totalAmountPaise,
      currency: booking.currency,
      name: 'Voyago',
      description: booking.package.title.slice(0, 250),
      callback_url: callback.toString(),
      redirect: true,
      theme: { color: '#0b6e4f' },
    };
    const title = escapeHtml(booking.package.title);
    const body = `<h1>${title}</h1>
<p class="muted">Run by ${escapeHtml(booking.package.operator.displayName)} · ${booking.seats} ${booking.seats === 1 ? 'place' : 'places'}</p>
<p class="total">${escapeHtml(formatPaise(booking.totalAmountPaise))}</p>
<p class="muted">Places are held until ${escapeHtml(booking.expiresAt!.toISOString().slice(11, 16))} UTC. Payment is handled by Razorpay; Voyago never sees your card or bank details.</p>
<button id="pay" type="button">Pay securely</button>${back}`;
    // JSON inside a script: escape "<" so the data can never close the tag.
    const data = JSON.stringify(options).replace(/</g, '\\u003c');
    const script = `<script src="https://checkout.razorpay.com/v1/checkout.js" nonce="${nonce}"></script>
<script nonce="${nonce}">
(function(){var o=${data};var rz=new Razorpay(o);var b=document.getElementById('pay');
b.addEventListener('click',function(){rz.open();});rz.open();})();
</script>`;
    return this.send(res, 200, nonce, page('Pay', body, nonce, script));
  }

  /** The provider's checkout posts here after a payment attempt (success or failure). */
  @Post(':id/razorpay')
  async razorpayReturn(
    @Param('id', idPipe) id: string,
    @Query() query: LinkQuery,
    @Body() body: CallbackBody,
    @Res() res: Response,
  ) {
    const nonce = randomBytes(16).toString('base64');
    let returnUrl: string | null;
    try {
      // The hold may lapse while the customer pays; the link itself must still be genuine.
      returnUrl = this.tokens.verify(id, query.e ?? '', query.r ?? '', query.s ?? '');
    } catch {
      return this.send(
        res,
        400,
        nonce,
        page('Link not valid', '<h1>This payment link is not valid</h1>', nonce),
      );
    }
    const status = await this.handleReturn(id, body ?? {});
    if (returnUrl) {
      res.redirect(303, this.withResult(returnUrl, id, status));
      return;
    }
    const message =
      status === 'paid'
        ? '<h1>Payment received</h1><p>Your booking is confirmed. You can go back to the app.</p>'
        : status === 'processing'
          ? '<h1>Payment is being checked</h1><p>We will update your booking as soon as the payment is confirmed.</p>'
          : '<h1>Payment did not go through</h1><p>No money was taken for this attempt. You can try again from the app.</p>';
    return this.send(res, 200, nonce, page('Payment', message, nonce));
  }

  private async handleReturn(
    id: string,
    body: CallbackBody,
  ): Promise<'paid' | 'failed' | 'processing'> {
    const payment = await this.prisma.payment.findFirst({
      where: { bookingId: id, provider: this.gateway.name },
      select: { providerOrderId: true },
      orderBy: { createdAt: 'desc' },
    });
    const orderId = payment?.providerOrderId;
    if (!orderId) return 'failed';
    const paymentId = body.razorpay_payment_id?.slice(0, 100);
    const signature = body.razorpay_signature?.slice(0, 200);
    const returnedOrder = body.razorpay_order_id;

    try {
      if (paymentId && signature) {
        if (
          returnedOrder !== orderId ||
          !this.gateway.verifyCheckoutSignature(orderId, paymentId, signature)
        ) {
          this.logger.warn(`Checkout return for booking ${id} had a bad signature`);
          return 'failed';
        }
        // The signature proves the return came from the provider; the payment's state and amount
        // come from the provider's API.
        const gp = await this.gateway.fetchPayment(paymentId);
        const result = await this.payments.applyPayment(gp);
        await this.events.recordCheckout(id, paymentId, `payment ${result}`);
        return this.statusOf(result, gp);
      }
      // A failed attempt: look the payment up if the provider named one, so the reason is kept.
      const metadata = this.parseMetadata(body['error[metadata]']);
      if (metadata?.payment_id && metadata.order_id === orderId) {
        const gp = await this.gateway.fetchPayment(metadata.payment_id.slice(0, 100));
        const result = await this.payments.applyPayment(gp);
        await this.events.recordCheckout(id, gp.id, `payment ${result}`);
        return this.statusOf(result, gp);
      }
    } catch (error) {
      // The webhook and reconciliation will settle it; tell the customer it's being checked.
      this.logger.warn(
        `Checkout return for booking ${id} could not be checked: ${(error as Error).message}`,
      );
      return 'processing';
    }
    return 'failed';
  }

  private statusOf(result: string, gp: GatewayPayment): 'paid' | 'failed' | 'processing' {
    if (result === 'confirmed' || result === 'already_confirmed' || result === 'late_confirmed')
      return 'paid';
    if (result === 'pending' || gp.status === 'authorized') return 'processing';
    return 'failed';
  }

  private parseMetadata(
    raw: string | undefined,
  ): { payment_id?: string; order_id?: string } | null {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as { payment_id?: string; order_id?: string } | null;
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  private withResult(returnUrl: string, bookingId: string, status: string): string {
    const url = new URL(returnUrl);
    url.searchParams.set('booking', bookingId);
    url.searchParams.set('payment', status);
    return url.toString();
  }

  private send(res: Response, status: number, nonce: string, html: string) {
    sendCheckoutPage(res, status, nonce, html);
  }
}

export function sendCheckoutPage(res: Response, status: number, nonce: string, html: string) {
  // Replaces the API's default policy for this page only: the provider's checkout needs its
  // script, frames and API, and nothing else is allowed.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' https://checkout.razorpay.com`,
      "style-src 'unsafe-inline'",
      'img-src https: data:',
      'frame-src https://api.razorpay.com https://checkout.razorpay.com',
      'connect-src https://api.razorpay.com https://lumberjack.razorpay.com',
      "form-action 'self' https://api.razorpay.com",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(status).type('html').send(html);
}
