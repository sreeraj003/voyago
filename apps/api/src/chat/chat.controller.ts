import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CommunitySlugSchema,
  ConversationsQuerySchema,
  MarkReadSchema,
  MessagesQuerySchema,
  MuteConversationSchema,
  SendMessageSchema,
  StartDirectChatSchema,
  UuidSchema,
} from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { ChatService } from './chat.service.js';

class ConversationsQueryDto extends createZodDto(ConversationsQuerySchema) {}
class MessagesQueryDto extends createZodDto(MessagesQuerySchema) {}
class StartDirectChatDto extends createZodDto(StartDirectChatSchema) {}
class SendMessageDto extends createZodDto(SendMessageSchema) {}
class MarkReadDto extends createZodDto(MarkReadSchema) {}
class MuteConversationDto extends createZodDto(MuteConversationSchema) {}

const idPipe = new ZodValidationPipe(UuidSchema);
const slugPipe = new ZodValidationPipe(CommunitySlugSchema);

/**
 * Chat over REST: history, opening chats and a send fallback. Live delivery, typing and presence
 * use the Socket.IO connection (see docs/API.md, "Realtime chat").
 */
@ApiTags('chat')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('me/conversations')
  @ApiOperation({ summary: 'My chats with messages, latest first' })
  @ApiErrorResponses(400)
  list(@CurrentUser() user: AuthUser, @Query() query: ConversationsQueryDto) {
    return this.chat.list(user.id, query);
  }

  @Get('me/conversations/unread-count')
  @ApiOperation({ summary: 'Unread messages across my recent chats (muted chats excluded)' })
  async unread(@CurrentUser() user: AuthUser) {
    return { data: { count: await this.chat.unreadTotal(user.id) } };
  }

  @Post('conversations/direct')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Open a direct chat with a member',
    description:
      "Returns the existing chat, or starts one if the member's message setting allows it (403 otherwise). Blocks close the chat both ways.",
  })
  @ApiErrorResponses(400, 403, 404)
  async direct(@CurrentUser() user: AuthUser, @Body() body: StartDirectChatDto) {
    return { data: await this.chat.openDirect(user.id, body.username) };
  }

  @Post('trips/:id/chat')
  @HttpCode(200)
  @ApiOperation({ summary: "Open a trip's group chat (people on the trip only)" })
  @ApiErrorResponses(400, 403, 404)
  async trip(@CurrentUser() user: AuthUser, @Param('id', idPipe) tripId: string) {
    return { data: await this.chat.openTrip(user.id, tripId) };
  }

  @Post('communities/:slug/chat')
  @HttpCode(200)
  @ApiOperation({ summary: "Open a community's group chat (active members only)" })
  @ApiErrorResponses(400, 403, 404)
  async community(@CurrentUser() user: AuthUser, @Param('slug', slugPipe) slug: string) {
    return { data: await this.chat.openCommunity(user.id, slug) };
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'One chat (members only; 404 for everyone else)' })
  @ApiErrorResponses(400, 404)
  async get(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.chat.get(user.id, id) };
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'Message history, newest first, by cursor' })
  @ApiErrorResponses(400, 404)
  messages(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Query() query: MessagesQueryDto,
  ) {
    return this.chat.messages(user.id, id, query);
  }

  @Post('conversations/:id/messages')
  @ApiOperation({
    summary: 'Send a message',
    description:
      'Same rules as the socket event message:send. Resending the same clientId returns the stored message (200) instead of a second copy (201).',
  })
  @ApiErrorResponses(400, 403, 404, 429, 503)
  async send(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: SendMessageDto,
  ) {
    const { message } = await this.chat.send(user.id, id, body);
    return { data: message };
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark the chat read up to a message (never moves back)' })
  @ApiErrorResponses(400, 404)
  async read(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: MarkReadDto,
  ) {
    return { data: await this.chat.markRead(user.id, id, body.messageId) };
  }

  @Post('conversations/:id/mute')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mute or unmute a chat (no notifications, except announcements)' })
  @ApiErrorResponses(400, 404)
  async mute(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: MuteConversationDto,
  ) {
    return { data: await this.chat.mute(user.id, id, body.muted) };
  }

  @Post('messages/:id/delete')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete one of my messages for everyone' })
  @ApiErrorResponses(400, 404)
  async remove(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    await this.chat.deleteMessage(user.id, id);
  }
}
