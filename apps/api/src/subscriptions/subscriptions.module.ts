import { Global, Module } from '@nestjs/common';
import { PermissionGuard } from '../admin/permissions.js';
import { DiscoveryModule } from '../discovery/discovery.module.js';
import { ParticipationModule } from '../participation/participation.module.js';
import { AdminSubscriptionsController } from './admin-subscriptions.controller.js';
import { AdminSubscriptionsService } from './admin-subscriptions.service.js';
import { EntitlementsService } from './entitlements.service.js';
import { ProFeaturesService } from './pro-features.service.js';
import { SubscriptionCheckoutController } from './subscription-checkout.controller.js';
import { ProFeaturesController, SubscriptionsController } from './subscriptions.controller.js';
import { SubscriptionsService } from './subscriptions.service.js';

/**
 * Subscriptions and the paid features (milestone 14). Global so any module can ask
 * EntitlementsService what a member may use.
 */
@Global()
@Module({
  imports: [DiscoveryModule, ParticipationModule],
  controllers: [
    SubscriptionsController,
    ProFeaturesController,
    SubscriptionCheckoutController,
    AdminSubscriptionsController,
  ],
  providers: [
    PermissionGuard,
    EntitlementsService,
    SubscriptionsService,
    ProFeaturesService,
    AdminSubscriptionsService,
  ],
  exports: [EntitlementsService, SubscriptionsService],
})
export class SubscriptionsModule {}
