import { Body, Controller, Get, Logger, Param, Post, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { formatPaise, UuidSchema } from '@voyago/shared';
import { type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Public } from '../common/auth/public.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { PrismaService } from '../database/prisma.service.js';
import { escapeHtml, page, sendCheckoutPage } from '../payments/checkout.controller.js';
import { CheckoutTokens } from '../payments/checkout-tokens.js';
import { PaymentGateway } from '../payments/payment-gateway.js';
import { SubscriptionsService } from './subscriptions.service.js';

const idPipe = new ZodValidationPipe(UuidSchema);
type LinkQuery = { e?: string; r?: string; s?: string };

/**
 * The first payment of a subscription, on the provider's checkout (which also sets up the
 * renewals mandate). As with bookings, the return is only a hint: the plan is switched on from the
 * provider's own records of the subscription and the payment.
 */
@ApiExcludeController()
@Public()
@Controller('checkout/subscriptions')
export class SubscriptionCheckoutController {
  private readonly logger = new Logger(SubscriptionCheckoutController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: CheckoutTokens,
    private readonly gateway: PaymentGateway,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  @Get(':id')
  async show(@Param('id', idPipe) id: string, @Query() query: LinkQuery, @Res() res: Response) {
    const nonce = randomBytes(16).toString('base64');
    let returnUrl: string | null;
    try {
      returnUrl = this.tokens.verifySubscription(id, query.e ?? '', query.r ?? '', query.s ?? '');
    } catch {
      return sendCheckoutPage(
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
    const sub = await this.prisma.subscription.findUnique({
      where: { id },
      select: {
        status: true,
        pricePaise: true,
        providerSubscriptionId: true,
        plan: { select: { name: true, billingInterval: true } },
      },
    });
    if (!sub)
      return sendCheckoutPage(
        res,
        404,
        nonce,
        page('Not found', '<h1>Subscription not found</h1>', nonce),
      );
    if (sub.status !== 'PENDING') {
      const back = returnUrl
        ? `<a class="button" href="${escapeHtml(this.withResult(returnUrl, id, sub.status === 'ACTIVE' || sub.status === 'PAST_DUE' ? 'paid' : 'cancelled'))}">Back to Voyago</a>`
        : '';
      return sendCheckoutPage(
        res,
        200,
        nonce,
        page(
          'Done',
          `<h1>Nothing to pay</h1><p>This subscription is already set up or has ended.</p>${back}`,
          nonce,
        ),
      );
    }
    if (
      this.tokens.isExpired(query.e ?? '0') ||
      !sub.providerSubscriptionId ||
      !this.gateway.enabled
    ) {
      return sendCheckoutPage(
        res,
        410,
        nonce,
        page(
          'Link ended',
          '<h1>This link has ended</h1><p>Open your plan in the app to get a new one.</p>',
          nonce,
        ),
      );
    }
    const callback = new URL(
      this.tokens.subscriptionCheckoutUrl(id, new Date(Number(query.e)), returnUrl),
    );
    callback.pathname = `${callback.pathname}/razorpay`;
    const options = {
      key: this.gateway.publicKey,
      subscription_id: sub.providerSubscriptionId,
      name: 'Voyago',
      description: `${sub.plan.name}, monthly`,
      callback_url: callback.toString(),
      redirect: true,
      theme: { color: '#0b6e4f' },
    };
    const back = returnUrl
      ? `<a class="button secondary" href="${escapeHtml(this.withResult(returnUrl, id, 'cancelled'))}">Not now</a>`
      : '';
    const body = `<h1>${escapeHtml(sub.plan.name)}</h1>
<p class="total">${escapeHtml(formatPaise(sub.pricePaise))} a month</p>
<p>Billed monthly until you cancel. We remind you 3 days before each renewal. Cancel any time in the app: you keep the plan until the end of the month you paid for and are not charged again.</p>
<p class="muted">Payment is handled by Razorpay; Voyago never sees your card or bank details.</p>
<button id="pay" type="button">Pay ${escapeHtml(formatPaise(sub.pricePaise))} and subscribe</button>${back}`;
    const data = JSON.stringify(options).replace(/</g, '\\u003c');
    // The customer starts the payment themselves (no automatic opening for a recurring charge).
    const script = `<script src="https://checkout.razorpay.com/v1/checkout.js" nonce="${nonce}"></script>
<script nonce="${nonce}">
(function(){var o=${data};var rz=new Razorpay(o);document.getElementById('pay').addEventListener('click',function(){rz.open();});})();
</script>`;
    return sendCheckoutPage(res, 200, nonce, page('Subscribe', body, nonce, script));
  }

  @Post(':id/razorpay')
  async razorpayReturn(
    @Param('id', idPipe) id: string,
    @Query() query: LinkQuery,
    @Body() body: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    const nonce = randomBytes(16).toString('base64');
    let returnUrl: string | null;
    try {
      returnUrl = this.tokens.verifySubscription(id, query.e ?? '', query.r ?? '', query.s ?? '');
    } catch {
      return sendCheckoutPage(
        res,
        400,
        nonce,
        page('Link not valid', '<h1>This payment link is not valid</h1>', nonce),
      );
    }
    let status: 'paid' | 'failed' | 'processing' = 'failed';
    const paymentId = body?.razorpay_payment_id?.slice(0, 100);
    const providerSubscriptionId = body?.razorpay_subscription_id?.slice(0, 100);
    const signature = body?.razorpay_signature?.slice(0, 200);
    if (paymentId && providerSubscriptionId && signature) {
      try {
        status = await this.subscriptions.applyCheckout(id, {
          paymentId,
          providerSubscriptionId,
          signature,
        });
      } catch (error) {
        this.logger.warn(
          `Subscription checkout return could not be checked: ${(error as Error).message}`,
        );
        status = 'processing';
      }
    }
    if (returnUrl) {
      res.redirect(303, this.withResult(returnUrl, id, status));
      return;
    }
    const message =
      status === 'paid'
        ? '<h1>You are subscribed</h1><p>Go back to the app to use your plan.</p>'
        : status === 'processing'
          ? '<h1>Payment is being checked</h1><p>Your plan switches on as soon as the payment is confirmed.</p>'
          : '<h1>Payment did not go through</h1><p>No money was taken for this attempt. You can try again from the app.</p>';
    return sendCheckoutPage(res, 200, nonce, page('Subscription', message, nonce));
  }

  private withResult(returnUrl: string, id: string, status: string): string {
    const url = new URL(returnUrl);
    url.searchParams.set('subscription', id);
    url.searchParams.set('payment', status);
    return url.toString();
  }
}
