import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CreateCheckInSchema,
  CreateEmergencyContactSchema,
  LocationUpdateSchema,
  RaiseSosSchema,
  ResolveSosSchema,
  StartSharingSchema,
  UuidSchema,
} from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { SafetyService } from './safety.service.js';

class StartSharingDto extends createZodDto(StartSharingSchema) {}
class LocationUpdateDto extends createZodDto(LocationUpdateSchema) {}
class CreateCheckInDto extends createZodDto(CreateCheckInSchema) {}
class RaiseSosDto extends createZodDto(RaiseSosSchema) {}
class ResolveSosDto extends createZodDto(ResolveSosSchema) {}
class CreateEmergencyContactDto extends createZodDto(CreateEmergencyContactSchema) {}

const idPipe = new ZodValidationPipe(UuidSchema);

/**
 * Live location, check-ins, SOS and emergency contacts. Everything here is for the trip's
 * active members only (others get 404), and people you have blocked, or who blocked you, are
 * left out both ways. There is no public location endpoint.
 */
@ApiTags('safety')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller()
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Get('trips/:id/safety')
  @ApiOperation({
    summary: 'Live location, check-ins and alerts for a trip I am on',
    description:
      'Who is sharing their location (with their latest point, if any), my own sharing session, recent check-ins and SOS alerts.',
  })
  @ApiErrorResponses(400, 404)
  async state(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.safety.state(user.id, id) };
  }

  @Post('trips/:id/location/share')
  @ApiOperation({
    summary: 'Start sharing my location with the trip',
    description:
      'Needs `consent: true` and a duration (at most 24 hours). Only while the trip is live: from 2 hours before departure until it ends. Starting again replaces the old session.',
  })
  @ApiErrorResponses(400, 404, 409)
  async share(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: StartSharingDto,
  ) {
    return { data: await this.safety.startSharing(user.id, id, body) };
  }

  @Post('trips/:id/location/stop')
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop sharing my location (my last point is deleted)' })
  @ApiErrorResponses(400, 404)
  async stop(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string): Promise<void> {
    await this.safety.stopSharing(user.id, id);
  }

  @Post('trips/:id/location')
  @HttpCode(200)
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Send one location reading',
    description:
      'The socket event `location:update` does the same. At most one reading every 3 seconds (429). Readings over 2 minutes old, or older than the last one, are ignored (`accepted: false`).',
  })
  @ApiErrorResponses(400, 404, 409, 429)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: LocationUpdateDto,
  ) {
    return { data: await this.safety.update(user.id, id, body) };
  }

  @Post('trips/:id/check-ins')
  @ApiOperation({
    summary: 'Check in on a trip (at the start, all good, or arrived safely)',
    description:
      'While the trip is live and for 24 hours after it is completed. Arriving safely also stops location sharing.',
  })
  @ApiErrorResponses(400, 404, 409)
  async checkIn(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: CreateCheckInDto,
  ) {
    return { data: await this.safety.checkIn(user.id, id, body) };
  }

  @Post('trips/:id/sos')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Raise an SOS',
    description:
      'Needs `confirm: true`. Notifies the trip members and texts my emergency contacts when SMS is set up. Voyago does not contact police or ambulance services; the response gives the local emergency number to call.',
  })
  @ApiErrorResponses(400, 404, 409, 429)
  async sos(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: RaiseSosDto,
  ) {
    return { data: await this.safety.raiseSos(user.id, id, body) };
  }

  @Post('sos/:id/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Close an SOS alert',
    description:
      'The member who raised it (SAFE or FALSE_ALARM) or the trip organiser (SAFE). The stored location is cleared.',
  })
  @ApiErrorResponses(400, 403, 404, 409)
  async resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: ResolveSosDto,
  ) {
    return { data: await this.safety.resolveSos(user.id, id, body.outcome) };
  }

  @Get('me/emergency-contacts')
  @ApiOperation({ summary: 'My emergency contacts' })
  async contacts(@CurrentUser() user: AuthUser) {
    return { data: await this.safety.contacts(user.id) };
  }

  @Post('me/emergency-contacts')
  @ApiOperation({
    summary: 'Add an emergency contact (up to 3)',
    description: 'Only texted when I raise an SOS. Never shown to anyone else.',
  })
  @ApiErrorResponses(400, 409)
  async addContact(@CurrentUser() user: AuthUser, @Body() body: CreateEmergencyContactDto) {
    return { data: await this.safety.addContact(user.id, body) };
  }

  @Delete('me/emergency-contacts/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove an emergency contact' })
  @ApiErrorResponses(400, 404)
  async removeContact(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
  ): Promise<void> {
    await this.safety.removeContact(user.id, id);
  }
}
