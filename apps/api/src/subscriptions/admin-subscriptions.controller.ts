import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminEndSubscriptionSchema,
  AdminSubscriptionsQuerySchema,
  UpdatePlanSchema,
  UuidSchema,
} from '@voyago/shared';
import {
  type Actor,
  CurrentActor,
  PermissionGuard,
  RequirePermission,
} from '../admin/permissions.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { AdminSubscriptionsService } from './admin-subscriptions.service.js';

class AdminSubscriptionsQueryDto extends createZodDto(AdminSubscriptionsQuerySchema) {}
class UpdatePlanDto extends createZodDto(UpdatePlanSchema) {}
class AdminEndSubscriptionDto extends createZodDto(AdminEndSubscriptionSchema) {}

const idPipe = new ZodValidationPipe(UuidSchema);

/** Plan prices and subscription support. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(PermissionGuard)
@ApiErrorResponses(401, 403)
@Controller('admin')
export class AdminSubscriptionsController {
  constructor(private readonly admin: AdminSubscriptionsService) {}

  @Get('subscription-plans')
  @RequirePermission('payments.read')
  @ApiOperation({ summary: 'Every plan, active or not, with its current subscribers' })
  async plans() {
    return { data: await this.admin.plans() };
  }

  @Patch('subscription-plans/:id')
  @RequirePermission('payments.manage')
  @ApiOperation({
    summary:
      'Change a price (new subscriptions only), take a plan off sale, or edit its description',
  })
  @ApiErrorResponses(400, 404)
  async updatePlan(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: UpdatePlanDto,
  ) {
    return { data: await this.admin.updatePlan(actor, id, body) };
  }

  @Get('subscriptions')
  @RequirePermission('payments.read')
  @ApiOperation({ summary: 'Subscriptions, newest first; search by username or provider id' })
  async list(@Query() query: AdminSubscriptionsQueryDto) {
    return this.admin.list(query);
  }

  @Get('subscriptions/:id')
  @RequirePermission('payments.read')
  @ApiOperation({ summary: 'A subscription with its payments' })
  @ApiErrorResponses(404)
  async get(@Param('id', idPipe) id: string) {
    return { data: await this.admin.get(id) };
  }

  @Post('subscriptions/:id/reconcile')
  @HttpCode(200)
  @RequirePermission('payments.manage')
  @ApiOperation({ summary: 'Re-check with the payment provider and apply what it says' })
  @ApiErrorResponses(404)
  async reconcile(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string) {
    return { data: await this.admin.reconcile(actor, id) };
  }

  @Post('subscriptions/:id/end')
  @HttpCode(200)
  @RequirePermission('payments.manage')
  @ApiOperation({
    summary: 'End now (paid features stop, no more charges), optionally refunding the last payment',
  })
  @ApiErrorResponses(400, 404, 409, 503)
  async end(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: AdminEndSubscriptionDto,
  ) {
    return { data: await this.admin.endNow(actor, id, body) };
  }
}
