import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';
import { Public } from '../common/auth/public.decorator.js';
import { PaymentEventsService } from './payment-events.service.js';

/**
 * Provider webhooks. Each is verified against its signature over the exact bytes received, stored
 * once per provider event id, and applied idempotently. Answers 200 once handled (including
 * repeats), 400 for a bad signature, and 5xx if applying failed, so the provider sends it again.
 */
@ApiTags('payments')
@Public()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly events: PaymentEventsService) {}

  @Post('razorpay')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async razorpay(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ) {
    const outcome = await this.events.razorpayWebhook(req.rawBody, signature, eventId);
    if (outcome.status === 'invalid') throw new BadRequestException('Invalid signature');
    return { status: outcome.status };
  }
}
