import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccountService } from './account.service.js';
import { MeController, UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule],
  controllers: [MeController, UsersController],
  providers: [UsersService, AccountService],
  exports: [UsersService],
})
export class UsersModule {}
