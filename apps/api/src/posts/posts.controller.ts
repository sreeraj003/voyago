import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreatePostSchema, CursorPageQuerySchema, UuidSchema } from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { PostsService } from './posts.service.js';

class CreatePostDto extends createZodDto(CreatePostSchema) {}
class FeedQueryDto extends createZodDto(CursorPageQuerySchema) {}

@ApiTags('posts')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller()
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get('feed')
  @ApiOperation({
    summary: 'My activity feed, newest first',
    description:
      'Posts and newly published trips from people I follow, my own, and my communities. Chronological, no ranking.',
  })
  @ApiErrorResponses(400)
  feed(@CurrentUser() user: AuthUser, @Query() query: FeedQueryDto) {
    return this.posts.feed(user, query);
  }

  @Post('posts')
  @ApiOperation({
    summary: 'Post a trip recap or destination photos',
    description:
      'Recaps need a completed trip you were on. Photos come from an upload signature (kind post-photo). Posts in a private community stay in it.',
  })
  @ApiErrorResponses(400, 503)
  async create(@CurrentUser() user: AuthUser, @Body() body: CreatePostDto) {
    return { data: await this.posts.create(user, body) };
  }

  @Delete('posts/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a post (author; community moderators and staff, audited)' })
  @ApiErrorResponses(400, 403, 404)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(UuidSchema)) id: string,
    @Req() req: { id?: string },
  ) {
    await this.posts.remove(user, id, req.id);
  }
}
