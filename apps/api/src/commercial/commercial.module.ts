import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { CommercialController } from './commercial.controller.js';
import { OperatorsService } from './operators.service.js';
import { PackagesService } from './packages.service.js';

@Module({
  imports: [IntegrationsModule],
  controllers: [CommercialController],
  providers: [OperatorsService, PackagesService],
  exports: [PackagesService],
})
export class CommercialModule {}
