import { type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { AUTH_RATE_LIMIT_SETTING } from './auth/auth-throttle.decorator.js';
import { requestIdMiddleware } from './common/request-id.js';
import { type AppConfig } from './config/app-config.js';
import { APP_VERSION } from './version.js';

export const API_PREFIX = 'api/v1';

/** Largest accepted JSON body. Uploads go straight to object storage, not through the API. */
export const JSON_BODY_LIMIT = '100kb';

/** Builds a fully configured app. Shared by main.ts and the integration tests. */
export async function createApp(
  config: AppConfig,
  options: { extraModules?: Type[] } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config, options.extraModules),
    // rawBody keeps the exact bytes for verifying provider webhook signatures.
    { bufferLogs: true, bodyParser: false, rawBody: true },
  );
  // Order matters: request ids first, so body-parsing errors are traceable too.
  app.use(requestIdMiddleware);
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: JSON_BODY_LIMIT, extended: false });
  app.set('trust proxy', config.TRUST_PROXY);
  app.set(AUTH_RATE_LIMIT_SETTING, config.AUTH_RATE_LIMIT_MAX);

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet());
  app.enableCors({
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false,
    credentials: true,
  });
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Voyago API')
      .setDescription('REST API for the Voyago social riding and travel platform')
      .setVersion(APP_VERSION)
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document);

  return app;
}
