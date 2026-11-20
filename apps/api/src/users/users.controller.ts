import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  MotorcycleInputSchema,
  UpdateMotorcycleSchema,
  UpdatePreferencesSchema,
  UpdateProfileSchema,
  UuidSchema,
} from '@voyago/shared';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { UsersService } from './users.service.js';

class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}
class UpdatePreferencesDto extends createZodDto(UpdatePreferencesSchema) {}
class MotorcycleInputDto extends createZodDto(MotorcycleInputSchema) {}
class UpdateMotorcycleDto extends createZodDto(UpdateMotorcycleSchema) {}

@ApiTags('me')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'My profile, including private contact details' })
  async me(@CurrentUser() user: AuthUser) {
    return { data: await this.users.getOwnProfile(user.id) };
  }

  @Patch()
  @ApiOperation({ summary: 'Update my profile' })
  @ApiErrorResponses(400, 409)
  async update(@CurrentUser() user: AuthUser, @Body() body: UpdateProfileDto) {
    return { data: await this.users.updateOwnProfile(user.id, body) };
  }

  @Get('preferences')
  @ApiOperation({ summary: 'My travel preferences and privacy settings' })
  async preferences(@CurrentUser() user: AuthUser) {
    return { data: await this.users.getPreferences(user.id) };
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Update my preferences (only the fields sent)' })
  @ApiErrorResponses(400)
  async updatePreferences(@CurrentUser() user: AuthUser, @Body() body: UpdatePreferencesDto) {
    return { data: await this.users.updatePreferences(user.id, body) };
  }

  @Get('motorcycles')
  @ApiOperation({ summary: 'My motorcycles' })
  async motorcycles(@CurrentUser() user: AuthUser) {
    return { data: await this.users.listMotorcycles(user.id) };
  }

  @Post('motorcycles')
  @ApiOperation({ summary: 'Add a motorcycle (no registration numbers or documents)' })
  @ApiErrorResponses(400, 409)
  async addMotorcycle(@CurrentUser() user: AuthUser, @Body() body: MotorcycleInputDto) {
    return { data: await this.users.addMotorcycle(user.id, body) };
  }

  @Patch('motorcycles/:id')
  @ApiOperation({ summary: 'Update one of my motorcycles' })
  @ApiErrorResponses(400, 404)
  async updateMotorcycle(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(UuidSchema)) id: string,
    @Body() body: UpdateMotorcycleDto,
  ) {
    return { data: await this.users.updateMotorcycle(user.id, id, body) };
  }

  @Delete('motorcycles/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove one of my motorcycles' })
  @ApiErrorResponses(400, 404)
  async deleteMotorcycle(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(UuidSchema)) id: string,
  ) {
    await this.users.deleteMotorcycle(user.id, id);
  }
}

@ApiTags('users')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(':username')
  @ApiOperation({
    summary: "A member's public profile",
    description:
      'Never includes email, phone or exact locations. Blocked or inactive members return 404.',
  })
  @ApiErrorResponses(400, 404)
  async profile(
    @CurrentUser() user: AuthUser,
    // Looser than UsernameSchema on purpose: lookups of reserved names simply return 404.
    @Param('username', new ZodValidationPipe(z.string().regex(/^[A-Za-z0-9_.]{3,30}$/)))
    username: string,
  ) {
    return { data: await this.users.getPublicProfile(user.id, username) };
  }
}
