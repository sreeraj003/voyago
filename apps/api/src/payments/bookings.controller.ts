import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BookingsQuerySchema,
  BookingViewQuerySchema,
  CancelBookingSchema,
  CreateBookingSchema,
  OperatorBookingsQuerySchema,
  ReasonBodySchema,
  UuidSchema,
} from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { BookingsService } from './bookings.service.js';

class CreateBookingDto extends createZodDto(CreateBookingSchema) {}
class CancelBookingDto extends createZodDto(CancelBookingSchema) {}
class BookingsQueryDto extends createZodDto(BookingsQuerySchema) {}
class OperatorBookingsQueryDto extends createZodDto(OperatorBookingsQuerySchema) {}
class ReasonDto extends createZodDto(ReasonBodySchema) {}
class BookingViewQueryDto extends createZodDto(BookingViewQuerySchema) {}

const idPipe = new ZodValidationPipe(UuidSchema);

/** Booking paid experiences, the customer's bookings, and the business's view of them. */
@ApiTags('bookings')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller()
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post('packages/:id/bookings')
  @ApiOperation({
    summary:
      'Hold places and start paying. The server prices the booking; send a fresh idempotency key per attempt',
  })
  @ApiErrorResponses(400, 403, 404, 409, 503)
  async create(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: CreateBookingDto,
  ) {
    return { data: await this.bookings.create(user.id, id, body) };
  }

  @Get('me/bookings')
  @ApiOperation({ summary: 'My bookings, newest first' })
  async mine(@CurrentUser() user: AuthUser, @Query() query: BookingsQueryDto) {
    return this.bookings.listMine(user.id, query);
  }

  @Get('bookings/:id')
  @ApiOperation({
    summary: 'One of my bookings, with payment, refunds and what cancelling returns',
  })
  @ApiErrorResponses(404)
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Query() query: BookingViewQueryDto,
  ) {
    return { data: await this.bookings.viewWithReturn(user.id, id, query.returnUrl) };
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel; refunded by the schedule agreed when booking' })
  @ApiErrorResponses(400, 404, 409)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: CancelBookingDto,
  ) {
    return { data: await this.bookings.cancel(user.id, id, body.reason) };
  }

  @Get('me/operator/bookings')
  @ApiOperation({ summary: "My business's bookings (customer names only), read-only" })
  @ApiErrorResponses(404)
  async operatorBookings(@CurrentUser() user: AuthUser, @Query() query: OperatorBookingsQueryDto) {
    return this.bookings.operatorBookings(user.id, query);
  }

  @Post('me/operator/bookings/:id/cancel')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel a confirmed booking; the customer gets a full refund' })
  @ApiErrorResponses(400, 404, 409)
  async operatorCancel(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    await this.bookings.operatorCancel(user.id, id, body.reason);
  }
}
