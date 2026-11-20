import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { type AppConfig } from './config/app-config.js';
import { APP_VERSION } from './version.js';

export const API_PREFIX = 'api/v1';

/** Builds a fully configured app. Shared by main.ts and the e2e tests. */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });

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
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document);

  return app;
}
