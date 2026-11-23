import { Module } from '@nestjs/common';
import { TripsModule } from '../trips/trips.module.js';
import { ParticipationController } from './participation.controller.js';
import { ParticipationService } from './participation.service.js';

@Module({
  imports: [TripsModule],
  controllers: [ParticipationController],
  providers: [ParticipationService],
  exports: [ParticipationService],
})
export class ParticipationModule {}
