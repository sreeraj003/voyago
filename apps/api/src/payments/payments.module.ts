import { Global, Module } from '@nestjs/common';
import { PermissionGuard } from '../admin/permissions.js';
import { AdminBookingsController } from './admin-bookings.controller.js';
import { AdminBookingsService } from './admin-bookings.service.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutTokens } from './checkout-tokens.js';
import { PaymentEventsService } from './payment-events.service.js';
import { PaymentGateway, RazorpayGateway } from './payment-gateway.js';
import { PaymentsService } from './payments.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { WebhooksController } from './webhooks.controller.js';

/**
 * Bookings and payments (milestone 13). Global so the package pages can ask whether booking is
 * open without importing this module.
 */
@Global()
@Module({
  controllers: [
    BookingsController,
    CheckoutController,
    WebhooksController,
    AdminBookingsController,
  ],
  providers: [
    { provide: PaymentGateway, useClass: RazorpayGateway },
    PermissionGuard,
    PaymentsService,
    BookingsService,
    CheckoutTokens,
    PaymentEventsService,
    ReconciliationService,
    AdminBookingsService,
  ],
  exports: [PaymentGateway, PaymentsService, BookingsService, CheckoutTokens, PaymentEventsService],
})
export class PaymentsModule {}
