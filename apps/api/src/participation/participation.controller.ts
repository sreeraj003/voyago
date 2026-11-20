import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateJoinRequestSchema,
  MyJoinRequestsQuerySchema,
  RejectJoinRequestSchema,
  RemoveParticipantSchema,
  TripJoinRequestsQuerySchema,
  UuidSchema,
} from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { ParticipationService } from './participation.service.js';

class CreateJoinRequestDto extends createZodDto(CreateJoinRequestSchema) {}
class RejectJoinRequestDto extends createZodDto(RejectJoinRequestSchema) {}
class RemoveParticipantDto extends createZodDto(RemoveParticipantSchema) {}
class TripJoinRequestsQueryDto extends createZodDto(TripJoinRequestsQuerySchema) {}
class MyJoinRequestsQueryDto extends createZodDto(MyJoinRequestsQuerySchema) {}

const idPipe = new ZodValidationPipe(UuidSchema);
type RequestWithId = { id?: string };

@ApiTags('participation')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller()
export class ParticipationController {
  constructor(private readonly participation: ParticipationService) {}

  @Post('trips/:id/join-requests')
  @ApiOperation({
    summary: 'Ask to join a trip',
    description:
      'Free community trips only. If the trip does not need approval the member joins at once (status APPROVED). Not for your own trip, private trips, full or finished trips.',
  })
  @ApiErrorResponses(400, 403, 404, 409)
  async create(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) tripId: string,
    @Body() body: CreateJoinRequestDto,
  ) {
    return { data: await this.participation.requestToJoin(user, tripId, body.message) };
  }

  @Get('trips/:id/join-requests')
  @ApiOperation({ summary: "A trip's join requests (organiser and staff), PENDING by default" })
  @ApiErrorResponses(400, 403, 404)
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) tripId: string,
    @Query() query: TripJoinRequestsQueryDto,
  ) {
    return this.participation.listForTrip(user, tripId, query);
  }

  @Get('me/join-requests')
  @ApiOperation({ summary: 'Join requests I have made, newest first' })
  @ApiErrorResponses(400)
  mine(@CurrentUser() user: AuthUser, @Query() query: MyJoinRequestsQueryDto) {
    return this.participation.listMine(user, query);
  }

  @Post('join-requests/:id/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve a request (organiser or staff)',
    description: 'Capacity is rechecked with the trip locked; 409 when the trip filled up.',
  })
  @ApiErrorResponses(400, 403, 404, 409)
  async approve(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Req() req: RequestWithId,
  ) {
    return { data: await this.participation.approve(user, id, req.id) };
  }

  @Post('join-requests/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decline a request, optionally with a reason shown to the member' })
  @ApiErrorResponses(400, 403, 404, 409)
  async reject(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: RejectJoinRequestDto,
    @Req() req: RequestWithId,
  ) {
    return { data: await this.participation.reject(user, id, body.reason, req.id) };
  }

  @Post('join-requests/:id/withdraw')
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw my pending request' })
  @ApiErrorResponses(400, 404, 409)
  async withdraw(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.participation.withdraw(user, id) };
  }

  @Get('trips/:id/participants')
  @ApiOperation({ summary: 'People on the trip (participants, organiser and staff only)' })
  @ApiErrorResponses(400, 403, 404)
  async participants(@CurrentUser() user: AuthUser, @Param('id', idPipe) tripId: string) {
    return { data: await this.participation.participants(user, tripId) };
  }

  @Post('trips/:id/participants/:userId/remove')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove someone from the trip (organiser or staff)',
    description: 'Recorded in the audit log. The reason, if given, is shown to the member.',
  })
  @ApiErrorResponses(400, 403, 404, 409)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) tripId: string,
    @Param('userId', idPipe) memberId: string,
    @Body() body: RemoveParticipantDto,
    @Req() req: RequestWithId,
  ) {
    await this.participation.remove(user, tripId, memberId, body.reason, req.id);
  }

  @Post('trips/:id/leave')
  @HttpCode(204)
  @ApiOperation({ summary: 'Leave a trip I joined' })
  @ApiErrorResponses(400, 404, 409)
  async leave(@CurrentUser() user: AuthUser, @Param('id', idPipe) tripId: string) {
    await this.participation.leave(user, tripId);
  }
}
