import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  DeleteAccountSchema,
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
import { AccountService } from './account.service.js';
import { UsersService } from './users.service.js';

class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}
class UpdatePreferencesDto extends createZodDto(UpdatePreferencesSchema) {}
class MotorcycleInputDto extends createZodDto(MotorcycleInputSchema) {}
class UpdateMotorcycleDto extends createZodDto(UpdateMotorcycleSchema) {}
class DeleteAccountDto extends createZodDto(DeleteAccountSchema) {}

@ApiTags('me')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly account: AccountService,
  ) {}

  @Get('deletion')
  @ApiOperation({
    summary: 'Whether my account can be deleted now, what is erased and what is kept',
  })
  async deletionStatus(@CurrentUser() user: AuthUser) {
    return { data: await this.account.deletionStatus(user) };
  }

  @Post('delete')
  @HttpCode(204)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Delete my account',
    description:
      'Needs `confirm: "DELETE"`, and the password for accounts that have one (otherwise a sign-in in the last 15 minutes). Refused with 409 and the reasons while something must be settled first (see GET /me/deletion). Signs out everywhere.',
  })
  @ApiErrorResponses(400, 401, 403, 409, 429)
  async deleteAccount(
    @CurrentUser() user: AuthUser,
    @Body() body: DeleteAccountDto,
    @Req() req: { id?: string },
  ) {
    await this.account.deleteAccount(user, body, req.id ?? null);
  }

  @Get('export')
  @Header('content-disposition', 'attachment; filename="voyago-data.json"')
  @Header('cache-control', 'no-store')
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @ApiOperation({ summary: 'Download everything Voyago holds about me, as JSON' })
  @ApiErrorResponses(429)
  async exportData(@CurrentUser() user: AuthUser) {
    return { data: await this.account.exportData(user) };
  }

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
