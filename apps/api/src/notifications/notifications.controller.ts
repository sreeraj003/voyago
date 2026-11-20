import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationsQuerySchema, UuidSchema } from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { NotificationsService } from './notifications.service.js';

class NotificationsQueryDto extends createZodDto(NotificationsQuerySchema) {}

@ApiTags('notifications')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'My in-app notifications, newest first' })
  @ApiErrorResponses(400)
  list(@CurrentUser() user: AuthUser, @Query() query: NotificationsQueryDto) {
    return this.notifications.list(user.id, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'How many notifications are unread' })
  async unread(@CurrentUser() user: AuthUser) {
    return { data: { count: await this.notifications.unreadCount(user.id) } };
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark every notification read' })
  async readAll(@CurrentUser() user: AuthUser) {
    return { data: { updated: await this.notifications.markAllRead(user.id) } };
  }

  @Post(':id/read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark one notification read' })
  @ApiErrorResponses(400, 404)
  async read(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(UuidSchema)) id: string,
  ) {
    await this.notifications.markRead(user.id, id);
  }
}
