import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateJoinRequestSchema,
  CreateTripInvitationSchema,
  MyInvitationsQuerySchema,
  MyJoinRequestsQuerySchema,
  SetParticipantRoleSchema,
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
class SetParticipantRoleDto extends createZodDto(SetParticipantRoleSchema) {}
class CreateTripInvitationDto extends createZodDto(CreateTripInvitationSchema) {}
class InvitationsQueryDto extends createZodDto(MyInvitationsQuerySchema) {}

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
  @ApiOperation({ summary: "A trip's join requests (organisers and staff), PENDING by default" })
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
    summary: 'Approve a request (organiser, co-organiser or staff)',
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
    summary: 'Remove someone from the trip (organiser, co-organiser or staff)',
    description:
      'Co-organisers can remove participants but not other co-organisers. Recorded in the audit log. The reason, if given, is shown to the member.',
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

  @Post('trips/:id/participants/:userId/role')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Make a participant a co-organiser, or back (organiser only)',
    description:
      'Co-organisers review join requests, invite people and remove participants. Returns the updated people list.',
  })
  @ApiErrorResponses(400, 403, 404, 409)
  async setRole(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) tripId: string,
    @Param('userId', idPipe) memberId: string,
    @Body() body: SetParticipantRoleDto,
  ) {
    return { data: await this.participation.setRole(user, tripId, memberId, body.role) };
  }

  @Post('trips/:id/invitations')
  @ApiOperation({
    summary: 'Invite a member by username (organisers)',
    description:
      'Private trips are joined only by invitation; on other trips accepting skips approval. Blocked or unknown usernames return 404.',
  })
  @ApiErrorResponses(400, 403, 404, 409)
  async invite(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) tripId: string,
    @Body() body: CreateTripInvitationDto,
  ) {
    return { data: await this.participation.invite(user, tripId, body.username) };
  }

  @Get('trips/:id/invitations')
  @ApiOperation({ summary: "A trip's invitations (organisers), PENDING by default" })
  @ApiErrorResponses(400, 403, 404)
  tripInvitations(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) tripId: string,
    @Query() query: InvitationsQueryDto,
  ) {
    return this.participation.listInvitationsForTrip(user, tripId, query);
  }

  @Get('me/trip-invitations')
  @ApiOperation({ summary: 'Trip invitations I have received, PENDING by default' })
  @ApiErrorResponses(400)
  myInvitations(@CurrentUser() user: AuthUser, @Query() query: InvitationsQueryDto) {
    return this.participation.listMyInvitations(user, query);
  }

  @Post('trip-invitations/:id/accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation and join the trip',
    description: 'Capacity is checked with the trip locked; 409 when the trip is full.',
  })
  @ApiErrorResponses(400, 403, 404, 409)
  async accept(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.participation.acceptInvitation(user, id) };
  }

  @Post('trip-invitations/:id/decline')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decline an invitation' })
  @ApiErrorResponses(400, 404, 409)
  async decline(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.participation.declineInvitation(user, id) };
  }

  @Post('trip-invitations/:id/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw an invitation (organisers)' })
  @ApiErrorResponses(400, 403, 404, 409)
  async revoke(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.participation.revokeInvitation(user, id) };
  }
}
