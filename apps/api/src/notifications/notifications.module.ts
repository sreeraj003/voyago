import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { NotificationsController, PushTokensController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { PushDispatcherService } from './push/push-dispatcher.service.js';
import { createPushSender, PUSH_SENDER } from './push/push-sender.js';

@Global()
@Module({
  controllers: [NotificationsController, PushTokensController],
  providers: [
    NotificationsService,
    PushDispatcherService,
    {
      provide: PUSH_SENDER,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => createPushSender(c),
    },
  ],
  exports: [NotificationsService, PUSH_SENDER],
})
export class NotificationsModule {}
