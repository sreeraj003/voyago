import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  NotificationsQuerySchema,
  RegisterPushTokenSchema,
  RemovePushTokenSchema,
  UuidSchema,
} from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { NotificationsService } from './notifications.service.js';

class NotificationsQueryDto extends createZodDto(NotificationsQuerySchema) {}
class RegisterPushTokenDto extends createZodDto(RegisterPushTokenSchema) {}
class RemovePushTokenDto extends createZodDto(RemovePushTokenSchema) {}

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
  @ApiOperation({
    summary: 'How many notifications are unread',
    description: 'Chat messages are left out: GET /me/conversations/unread-count counts those.',
  })
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

@ApiTags('notifications')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller('me/push-tokens')
export class PushTokensController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Register this device for push notifications',
    description: 'An Expo push token. Pushes are sent only when the server has a push provider.',
  })
  @ApiErrorResponses(400)
  async register(@CurrentUser() user: AuthUser, @Body() body: RegisterPushTokenDto) {
    await this.notifications.registerPushToken(user.id, body.token, body.platform);
  }

  @Post('remove')
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop push notifications to this device (call before signing out)' })
  @ApiErrorResponses(400)
  async remove(@CurrentUser() user: AuthUser, @Body() body: RemovePushTokenDto) {
    await this.notifications.removePushToken(user.id, body.token);
  }
}
