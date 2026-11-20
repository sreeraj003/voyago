import { Module } from '@nestjs/common';
import { TripExpiryService } from './trip-expiry.service.js';
import { TripReminderService } from './trip-reminder.service.js';
import { TripsController } from './trips.controller.js';
import { TripsService } from './trips.service.js';

@Module({
  controllers: [TripsController],
  providers: [TripsService, TripExpiryService, TripReminderService],
  exports: [TripsService],
})
export class TripsModule {}
