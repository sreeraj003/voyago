import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { createEmailSender, EMAIL_SENDER } from './delivery/email-sender.js';
import { createSmsSender, SMS_SENDER } from './delivery/sms-sender.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import { OtpService } from './otp.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import {
  remoteKeyResolvers,
  SOCIAL_KEY_RESOLVERS,
  SocialTokenVerifier,
} from './social/social-token.verifier.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginAttemptsService,
    OtpService,
    PasswordService,
    SessionService,
    SocialTokenVerifier,
    TokenService,
    { provide: SMS_SENDER, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createSmsSender(c) },
    {
      provide: EMAIL_SENDER,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => createEmailSender(c),
    },
    { provide: SOCIAL_KEY_RESOLVERS, useFactory: remoteKeyResolvers },
  ],
  // The global AuthGuard (registered in AppModule) needs these.
  exports: [TokenService, SessionService, PasswordService, SMS_SENDER],
})
export class AuthModule {}
