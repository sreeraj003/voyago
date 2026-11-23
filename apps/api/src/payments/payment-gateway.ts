import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { HTTP_FETCH, type HttpFetch } from '../integrations/http-fetch.js';

/** Provider calls get longer than other integrations: refunds and captures can be slow. */
const PAYMENT_TIMEOUT_MS = 15_000;

/** What the provider says about one payment. Amounts in paise. */
export type GatewayPayment = {
  id: string;
  orderId: string | null;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  amountPaise: number;
  currency: string;
  feePaise: number | null;
  taxPaise: number | null;
  method: string | null;
  errorCode: string | null;
  errorDescription: string | null;
};

export type GatewayRefund = {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: 'pending' | 'processed' | 'failed';
};

export type GatewayOrder = { id: string; amountPaise: number; currency: string };

/**
 * The payment provider, behind one interface. Razorpay is the provider implemented (Orders,
 * Checkout, Payments, Refunds and webhooks). Card details never reach Voyago: customers pay on
 * the provider's checkout, and the server only sees ids, statuses and amounts.
 */
export abstract class PaymentGateway {
  abstract readonly name: string;
  abstract readonly enabled: boolean;
  /** Public key the checkout page needs. */
  abstract readonly publicKey: string;
  abstract createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder>;
  abstract fetchPayment(paymentId: string): Promise<GatewayPayment>;
  abstract capture(
    paymentId: string,
    amountPaise: number,
    currency: string,
  ): Promise<GatewayPayment>;
  abstract orderPayments(orderId: string): Promise<GatewayPayment[]>;
  abstract refund(input: {
    paymentId: string;
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayRefund>;
  abstract fetchRefund(paymentId: string, refundId: string): Promise<GatewayRefund>;
  /** The signature the checkout returns for `orderId|paymentId`. */
  abstract verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean;
  abstract verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}

export function hmacHex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time comparison of two hex signatures. */
export function sameSignature(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

type RazorpayPaymentEntity = {
  id: string;
  order_id?: string | null;
  status: GatewayPayment['status'];
  amount: number;
  currency: string;
  fee?: number | null;
  tax?: number | null;
  method?: string | null;
  error_code?: string | null;
  error_description?: string | null;
};

type RazorpayRefundEntity = {
  id: string;
  payment_id: string;
  amount: number;
  status: GatewayRefund['status'];
};

export function fromRazorpayPayment(p: RazorpayPaymentEntity): GatewayPayment {
  return {
    id: p.id,
    orderId: p.order_id ?? null,
    status: p.status,
    amountPaise: p.amount,
    currency: p.currency,
    feePaise: typeof p.fee === 'number' ? p.fee : null,
    taxPaise: typeof p.tax === 'number' ? p.tax : null,
    method: p.method ? String(p.method).slice(0, 30) : null,
    errorCode: p.error_code ?? null,
    errorDescription: p.error_description ? String(p.error_description).slice(0, 500) : null,
  };
}

export function fromRazorpayRefund(r: RazorpayRefundEntity): GatewayRefund {
  return { id: r.id, paymentId: r.payment_id, amountPaise: r.amount, status: r.status };
}

@Injectable()
export class RazorpayGateway extends PaymentGateway {
  readonly name = 'razorpay';
  private readonly logger = new Logger(RazorpayGateway.name);
  private readonly base = 'https://api.razorpay.com/v1';

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(HTTP_FETCH) private readonly fetchImpl: HttpFetch,
  ) {
    super();
  }

  get enabled(): boolean {
    return this.config.PAYMENT_PROVIDER === 'razorpay';
  }

  get publicKey(): string {
    return this.config.RAZORPAY_KEY_ID;
  }

  async createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder> {
    const order = await this.call<{ id: string; amount: number; currency: string }>(
      'POST',
      '/orders',
      {
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes,
      },
    );
    return { id: order.id, amountPaise: order.amount, currency: order.currency };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    return fromRazorpayPayment(
      await this.call<RazorpayPaymentEntity>('GET', `/payments/${encodeURIComponent(paymentId)}`),
    );
  }

  async capture(paymentId: string, amountPaise: number, currency: string) {
    return fromRazorpayPayment(
      await this.call<RazorpayPaymentEntity>(
        'POST',
        `/payments/${encodeURIComponent(paymentId)}/capture`,
        { amount: amountPaise, currency },
      ),
    );
  }

  async orderPayments(orderId: string): Promise<GatewayPayment[]> {
    const list = await this.call<{ items: RazorpayPaymentEntity[] }>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/payments`,
    );
    return list.items.map(fromRazorpayPayment);
  }

  async refund(input: {
    paymentId: string;
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayRefund> {
    return fromRazorpayRefund(
      await this.call<RazorpayRefundEntity>(
        'POST',
        `/payments/${encodeURIComponent(input.paymentId)}/refund`,
        { amount: input.amountPaise, speed: 'normal', receipt: input.receipt, notes: input.notes },
      ),
    );
  }

  async fetchRefund(paymentId: string, refundId: string): Promise<GatewayRefund> {
    return fromRazorpayRefund(
      await this.call<RazorpayRefundEntity>(
        'GET',
        `/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`,
      ),
    );
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    if (!this.config.RAZORPAY_KEY_SECRET) return false;
    return sameSignature(
      hmacHex(this.config.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`),
      signature,
    );
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    if (!this.config.RAZORPAY_WEBHOOK_SECRET) return false;
    return sameSignature(hmacHex(this.config.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.enabled) throw new ServiceUnavailableException('Payments are not set up yet');
    const auth = Buffer.from(
      `${this.config.RAZORPAY_KEY_ID}:${this.config.RAZORPAY_KEY_SECRET}`,
    ).toString('base64');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(PAYMENT_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn(
        `Razorpay ${method} ${path.split('/')[1]} failed: ${(error as Error).message}`,
      );
      throw new PaymentProviderError('The payment provider could not be reached', true);
    }
    const json = (await res.json().catch(() => ({}))) as T & {
      error?: { code?: string; description?: string };
    };
    if (!res.ok) {
      this.logger.warn(`Razorpay ${method} ${path.split('/')[1]} responded ${res.status}`);
      throw new PaymentProviderError(
        json.error?.description ?? `The payment provider responded ${res.status}`,
        res.status >= 500 || res.status === 429,
      );
    }
    return json;
  }
}

/** A provider call that failed. `retryable`: network trouble or a provider outage. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
