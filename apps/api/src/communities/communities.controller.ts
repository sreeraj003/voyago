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
  CommunitiesQuerySchema,
  CommunityMembersQuerySchema,
  CommunitySlugSchema,
  CommunityTripsQuerySchema,
  CreateAnnouncementSchema,
  CreateCommunitySchema,
  CursorPageQuerySchema,
  JoinCommunitySchema,
  RemoveCommunityMemberSchema,
  SetCommunityRoleSchema,
  UpdateCommunitySchema,
  UuidSchema,
} from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { CommunitiesService } from './communities.service.js';

class CreateCommunityDto extends createZodDto(CreateCommunitySchema) {}
class UpdateCommunityDto extends createZodDto(UpdateCommunitySchema) {}
class CommunitiesQueryDto extends createZodDto(CommunitiesQuerySchema) {}
class JoinCommunityDto extends createZodDto(JoinCommunitySchema) {}
class MembersQueryDto extends createZodDto(CommunityMembersQuerySchema) {}
class SetRoleDto extends createZodDto(SetCommunityRoleSchema) {}
class RemoveMemberDto extends createZodDto(RemoveCommunityMemberSchema) {}
class TripsQueryDto extends createZodDto(CommunityTripsQuerySchema) {}
class PostsQueryDto extends createZodDto(CursorPageQuerySchema) {}
class AnnouncementDto extends createZodDto(CreateAnnouncementSchema) {}

const slugPipe = new ZodValidationPipe(CommunitySlugSchema);
const idPipe = new ZodValidationPipe(UuidSchema);
type RequestWithId = { id?: string };

@ApiTags('communities')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller('communities')
export class CommunitiesController {
  constructor(private readonly communities: CommunitiesService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a community (you become its owner)',
    description: 'Private communities always approve each member.',
  })
  @ApiErrorResponses(400, 409, 503)
  async create(@CurrentUser() user: AuthUser, @Body() body: CreateCommunityDto) {
    return { data: await this.communities.create(user, body) };
  }

  @Get()
  @ApiOperation({
    summary: 'Find communities',
    description:
      'Private communities are listed with their name and description only, so people can ask to join.',
  })
  @ApiErrorResponses(400)
  list(@CurrentUser() user: AuthUser, @Query() query: CommunitiesQueryDto) {
    return this.communities.list(user, query);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'A community, with my role and what I can do' })
  @ApiErrorResponses(400, 404)
  async get(@CurrentUser() user: AuthUser, @Param('slug', slugPipe) slug: string) {
    return { data: await this.communities.get(user, slug) };
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Edit the community (admins and the owner)' })
  @ApiErrorResponses(400, 403, 404, 503)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('slug', slugPipe) slug: string,
    @Body() body: UpdateCommunityDto,
  ) {
    return { data: await this.communities.update(user, slug, body) };
  }

  @Delete(':slug')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete the community (owner only)' })
  @ApiErrorResponses(400, 403, 404)
  async remove(@CurrentUser() user: AuthUser, @Param('slug', slugPipe) slug: string) {
    await this.communities.remove(user, slug);
  }

  @Post(':slug/join')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Join, or ask to join',
    description: 'Open public communities: joined at once. Otherwise a request for moderators.',
  })
  @ApiErrorResponses(400, 403, 404, 409)
  async join(
    @CurrentUser() user: AuthUser,
    @Param('slug', slugPipe) slug: string,
    @Body() body: JoinCommunityDto,
  ) {
    return { data: await this.communities.join(user, slug, body.message) };
  }

  @Post(':slug/leave')
  @HttpCode(200)
  @ApiOperation({ summary: 'Leave, or cancel my request (the owner cannot leave)' })
  @ApiErrorResponses(400, 404, 409)
  async leave(@CurrentUser() user: AuthUser, @Param('slug', slugPipe) slug: string) {
    return { data: await this.communities.leave(user, slug) };
  }

  @Get(':slug/members')
  @ApiOperation({
    summary: 'Members (ACTIVE), or requests and bans (moderators)',
    description: 'Members of a private community are visible to its members only.',
  })
  @ApiErrorResponses(400, 403, 404)
  members(
    @CurrentUser() user: AuthUser,
    @Param('slug', slugPipe) slug: string,
    @Query() query: MembersQueryDto,
  ) {
    return this.communities.members(user, slug, query);
  }

  @Post(':slug/members/:userId/approve')
  @HttpCode(204)
  @ApiOperation({ summary: 'Approve a request to join (moderators; audited)' })
  @ApiErrorResponses(400, 403, 404)
  async approve(
    @CurrentUser() user: AuthUser,
    @Param('slug', slugPipe) slug: string,
    @Param('userId', idPipe) memberId: string,
    @Req() req: RequestWithId,
  ) {
    await this.communities.approve(user, slug, memberId, req.id);
  }

  @Post(':slug/members/:userId/reject')
  @HttpCode(204)
  @ApiOperation({ summary: 'Decline a request to join (moderators; audited)' })
  @ApiErrorResponses(400, 403, 404)
  async reject(
    @CurrentUser() user: AuthUser,
    @Param('slug', slugPipe) slug: string,
    @Param('userId', idPipe) memberId: string,
    @Req() req: RequestWithId,
  ) {
    await this.communities.reject(user, slug, memberId, req.id);
  }

  @Post(':slug/members/:userId/role')
  @HttpCode(204)
  @ApiOperation({
    summary: "Change a member's role (admins and the owner; audited)",
    description:
      'Only roles below your own, for members below your own rank. Nobody can change their own role.',
  })
  @ApiErrorResponses(400, 403, 404)
  async setRole(
    @CurrentUser() user: AuthUser,
    @Param('slug', slugPipe) slug: string,
    @Param('userId', idPipe) memberId: string,
    @Body() body: SetRoleDto,
    @Req() req: RequestWithId,
  ) {
    await this.communities.setRole(user, slug, memberId, body.role, req.id);
  }

  @Post(':slug/members/:userId/remove')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove or ban a member (moderators, below their own rank; audited)',
  })
  @ApiErrorResponses(400, 403, 404, 409)
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('slug', slugPipe) slug: string,
    @Param('userId', idPipe) memberId: string,
    @Body() body: RemoveMemberDto,
    @Req() req: RequestWithId,
  ) {
    await this.communities.removeMember(user, slug, memberId, body, req.id);
  }

  @Post(':slug/members/:userId/unban')
  @HttpCode(204)
  @ApiOperation({ summary: 'Lift a ban (admins; audited)' })
  @ApiErrorResponses(400, 403, 404)
  async unban(
    @CurrentUser() user: AuthUser,
    @Param('slug', slugPipe) slug: string,
    @Param('userId', idPipe) memberId: string,
    @Req() req: RequestWithId,
  ) {
    await this.communities.unban(user, slug, memberId, req.id);
  }

  @Get(':slug/trips')
  @ApiOperation({
    summary: "The community's trips, upcoming (soonest first) or past",
    description: 'Members-only trips appear to members only.',
  })
  @ApiErrorResponses(400, 403, 404)
  trips(
    @CurrentUser() user: AuthUser,
    @Param('slug', slugPipe) slug: string,
    @Query() query: TripsQueryDto,
  ) {
    return this.communities.trips(user, slug, query);
  }

  @Get(':slug/posts')
  @ApiOperation({ summary: "The community's posts and announcements, newest first" })
  @ApiErrorResponses(400, 403, 404)
  posts(
    @CurrentUser() user: AuthUser,
    @Param('slug', slugPipe) slug: string,
    @Query() query: PostsQueryDto,
  ) {
    return this.communities.postsFor(user, slug, query);
  }

  @Post(':slug/announcements')
  @ApiOperation({ summary: 'Post an announcement (moderators); members are notified' })
  @ApiErrorResponses(400, 403, 404)
  async announce(
    @CurrentUser() user: AuthUser,
    @Param('slug', slugPipe) slug: string,
    @Body() body: AnnouncementDto,
  ) {
    return { data: await this.communities.announce(user, slug, body) };
  }
}
