import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CancelTripSchema,
  CreateTripSchema,
  MyTripsQuerySchema,
  UpdateTripSchema,
  UuidSchema,
} from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { TripsService } from './trips.service.js';

class CreateTripDto extends createZodDto(CreateTripSchema) {}
class UpdateTripDto extends createZodDto(UpdateTripSchema) {}
class CancelTripDto extends createZodDto(CancelTripSchema) {}
class MyTripsQueryDto extends createZodDto(MyTripsQuerySchema) {}

const idPipe = new ZodValidationPipe(UuidSchema);

@ApiTags('trips')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller()
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Post('trips')
  @ApiOperation({
    summary: 'Create a community trip (as a draft)',
    description:
      'Free community trips only: members share their own costs. Paid passenger seats, driver matching and ride-hailing are not supported.',
  })
  @ApiErrorResponses(400)
  async create(@CurrentUser() user: AuthUser, @Body() body: CreateTripDto) {
    return { data: await this.trips.create(user, body) };
  }

  @Get('trips/:id')
  @ApiOperation({
    summary: 'Trip details',
    description:
      'Drafts are visible to their organiser only, private trips to participants only. The exact meeting point is shown to participants; others see it rounded to about 1 km.',
  })
  @ApiErrorResponses(400, 404)
  async get(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.trips.view(user, id) };
  }

  @Patch('trips/:id')
  @ApiOperation({
    summary: 'Edit my trip',
    description:
      'Send only changed fields; `stops` replaces the list. After the trip starts only the description can change; mode and activity are fixed once published.',
  })
  @ApiErrorResponses(400, 403, 404, 409)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: UpdateTripDto,
  ) {
    return { data: await this.trips.update(user, id, body) };
  }

  @Delete('trips/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete my draft (published trips are cancelled instead)' })
  @ApiErrorResponses(400, 403, 404, 409)
  async remove(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    await this.trips.deleteDraft(user, id);
  }

  @Post('trips/:id/publish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish my draft (departure must be in the future)' })
  @ApiErrorResponses(400, 403, 404, 409)
  async publish(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.trips.publish(user, id) };
  }

  @Post('trips/:id/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark my trip as started (from 2 hours before departure)' })
  @ApiErrorResponses(400, 403, 404, 409)
  async start(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.trips.start(user, id) };
  }

  @Post('trips/:id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark my started trip as completed' })
  @ApiErrorResponses(400, 403, 404, 409)
  async complete(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.trips.complete(user, id) };
  }

  @Post('trips/:id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel a trip',
    description:
      'The organiser, or a moderator/admin (recorded in the audit log). A reason is required.',
  })
  @ApiErrorResponses(400, 403, 404, 409)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: CancelTripDto,
    @Req() req: { id?: string },
  ) {
    return { data: await this.trips.cancel(user, id, body.reason, req.id) };
  }

  @Get('me/trips')
  @ApiOperation({ summary: 'Trips I organise or have joined, newest first' })
  @ApiErrorResponses(400)
  async mine(@CurrentUser() user: AuthUser, @Query() query: MyTripsQueryDto) {
    return this.trips.listMine(user, query);
  }
}
