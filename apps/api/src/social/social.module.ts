import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module.js';
import { SocialController } from './social.controller.js';
import { SocialService } from './social.service.js';

@Module({
  imports: [ChatModule],
  controllers: [SocialController],
  providers: [SocialService],
})
export class SocialModule {}
