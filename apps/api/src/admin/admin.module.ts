import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { TripsModule } from '../trips/trips.module.js';
import { AdminContentService } from './admin-content.service.js';
import { AdminOperatorsService } from './admin-operators.service.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { AdminReportsService } from './admin-reports.service.js';
import { AdminUsersService } from './admin-users.service.js';
import {
  AdminContentController,
  AdminOperatorsController,
  AdminOverviewController,
  AdminReportsController,
  AdminUsersController,
} from './admin.controller.js';
import { PermissionGuard } from './permissions.js';

/** The admin dashboard and moderation API (milestone 10). */
@Module({
  imports: [TripsModule, IntegrationsModule],
  controllers: [
    AdminOverviewController,
    AdminUsersController,
    AdminContentController,
    AdminReportsController,
    AdminOperatorsController,
  ],
  providers: [
    PermissionGuard,
    AdminOverviewService,
    AdminUsersService,
    AdminContentService,
    AdminReportsService,
    AdminOperatorsService,
  ],
})
export class AdminModule {}
