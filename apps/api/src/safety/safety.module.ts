import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SafetySweepService } from './safety-sweep.service.js';
import { SafetyController } from './safety.controller.js';
import { SafetyService } from './safety.service.js';

@Module({
  imports: [AuthModule],
  controllers: [SafetyController],
  providers: [SafetyService, SafetySweepService],
  exports: [SafetyService],
})
export class SafetyModule {}
