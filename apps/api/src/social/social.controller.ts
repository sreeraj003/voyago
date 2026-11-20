import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConnectionsQuerySchema, CreateReportSchema } from '@voyago/shared';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { SocialService } from './social.service.js';

class ConnectionsQueryDto extends createZodDto(ConnectionsQuerySchema) {}
class CreateReportDto extends createZodDto(CreateReportSchema) {}

const usernamePipe = new ZodValidationPipe(z.string().regex(/^[A-Za-z0-9_.]{3,30}$/));

@ApiTags('social')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller()
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Post('users/:username/follow')
  @HttpCode(204)
  @ApiOperation({ summary: 'Follow a member (no-op if already following)' })
  @ApiErrorResponses(400, 404, 409)
  async follow(@CurrentUser() user: AuthUser, @Param('username', usernamePipe) username: string) {
    await this.social.follow(user, username);
  }

  @Delete('users/:username/follow')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unfollow a member' })
  @ApiErrorResponses(400, 404)
  async unfollow(@CurrentUser() user: AuthUser, @Param('username', usernamePipe) username: string) {
    await this.social.unfollow(user, username);
  }

  @Get('users/:username/followers')
  @ApiOperation({
    summary: "A member's followers",
    description: '403 when their profile is not fully visible to you. Blocked people are left out.',
  })
  @ApiErrorResponses(400, 403, 404)
  followers(
    @CurrentUser() user: AuthUser,
    @Param('username', usernamePipe) username: string,
    @Query() query: ConnectionsQueryDto,
  ) {
    return this.social.followers(user, username, query);
  }

  @Get('users/:username/following')
  @ApiOperation({ summary: 'Who a member follows (same privacy as followers)' })
  @ApiErrorResponses(400, 403, 404)
  following(
    @CurrentUser() user: AuthUser,
    @Param('username', usernamePipe) username: string,
    @Query() query: ConnectionsQueryDto,
  ) {
    return this.social.following(user, username, query);
  }

  @Post('users/:username/block')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Block a member',
    description:
      'Free and always available. Hides each of you from the other and removes follows both ways.',
  })
  @ApiErrorResponses(400, 404, 409)
  async block(@CurrentUser() user: AuthUser, @Param('username', usernamePipe) username: string) {
    await this.social.block(user, username);
  }

  @Delete('users/:username/block')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unblock a member' })
  @ApiErrorResponses(400, 404)
  async unblock(@CurrentUser() user: AuthUser, @Param('username', usernamePipe) username: string) {
    await this.social.unblock(user, username);
  }

  @Get('me/blocks')
  @ApiOperation({ summary: 'People I have blocked' })
  async blocks(@CurrentUser() user: AuthUser) {
    return { data: await this.social.blocks(user) };
  }

  @Post('reports')
  @ApiOperation({
    summary: 'Report a member, trip, community, post or chat message',
    description:
      'Goes to the moderation queue. Reporting the same thing again while open is merged.',
  })
  @ApiErrorResponses(400, 404, 409)
  async report(@CurrentUser() user: AuthUser, @Body() body: CreateReportDto) {
    return { data: await this.social.report(user, body) };
  }
}
