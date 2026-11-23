import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminBookingsQuerySchema, AdminRefundSchema, UuidSchema } from '@voyago/shared';
import {
  type Actor,
  CurrentActor,
  PermissionGuard,
  RequirePermission,
} from '../admin/permissions.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { AdminBookingsService } from './admin-bookings.service.js';

class AdminBookingsQueryDto extends createZodDto(AdminBookingsQuerySchema) {}
class AdminRefundDto extends createZodDto(AdminRefundSchema) {}

const idPipe = new ZodValidationPipe(UuidSchema);

/** Payments support: bookings, their money trail, reconciliation and refunds. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(PermissionGuard)
@ApiErrorResponses(401, 403)
@Controller('admin')
export class AdminBookingsController {
  constructor(private readonly bookings: AdminBookingsService) {}

  @Get('bookings')
  @RequirePermission('payments.read')
  @ApiOperation({
    summary: 'Bookings, newest first; `attention=true` for those that need a person',
  })
  async list(@Query() query: AdminBookingsQueryDto) {
    return this.bookings.list(query);
  }

  @Get('bookings/:id')
  @RequirePermission('payments.read')
  @ApiOperation({ summary: 'A booking with its payments, refunds, ledger and provider events' })
  @ApiErrorResponses(404)
  async get(@Param('id', idPipe) id: string) {
    return { data: await this.bookings.get(id) };
  }

  @Post('bookings/:id/reconcile')
  @HttpCode(200)
  @RequirePermission('payments.manage')
  @ApiOperation({
    summary: 'Re-check the booking with the payment provider and apply what it says',
  })
  @ApiErrorResponses(404, 409)
  async reconcile(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string) {
    return { data: await this.bookings.reconcile(actor, id) };
  }

  @Post('bookings/:id/refund')
  @HttpCode(200)
  @RequirePermission('payments.manage')
  @ApiOperation({
    summary:
      'Refund an amount (the booking stands), or everything left when no amount is given (cancels the booking)',
  })
  @ApiErrorResponses(400, 404, 409)
  async refund(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: AdminRefundDto,
  ) {
    return { data: await this.bookings.refund(actor, id, body) };
  }

  @Post('refunds/:id/retry')
  @HttpCode(200)
  @RequirePermission('payments.manage')
  @ApiOperation({ summary: 'Send a failed refund to the provider again' })
  @ApiErrorResponses(404, 409)
  async retry(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string) {
    return { data: await this.bookings.retryRefund(actor, id) };
  }
}
