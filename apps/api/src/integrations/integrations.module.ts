import { Global, Module } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service.js';
import { HTTP_FETCH } from './http-fetch.js';
import { GoogleMapsService } from './google-maps.service.js';
import { IntegrationsController } from './integrations.controller.js';

@Global()
@Module({
  controllers: [IntegrationsController],
  providers: [
    GoogleMapsService,
    CloudinaryService,
    {
      provide: HTTP_FETCH,
      useValue: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    },
  ],
  exports: [GoogleMapsService, CloudinaryService, HTTP_FETCH],
})
export class IntegrationsModule {}
