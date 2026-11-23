import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BulkJoinRequestsSchema,
  CancelSubscriptionSchema,
  CreateSavedSearchSchema,
  CursorPageQuerySchema,
  SubscribeSchema,
  SubscriptionViewQuerySchema,
  UpdateProfileStyleSchema,
  UpdateSavedSearchSchema,
  UuidSchema,
} from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { ProFeaturesService } from './pro-features.service.js';
import { SubscriptionsService } from './subscriptions.service.js';

class SubscribeDto extends createZodDto(SubscribeSchema) {}
class CancelSubscriptionDto extends createZodDto(CancelSubscriptionSchema) {}
class SubscriptionViewQueryDto extends createZodDto(SubscriptionViewQuerySchema) {}
class CreateSavedSearchDto extends createZodDto(CreateSavedSearchSchema) {}
class UpdateSavedSearchDto extends createZodDto(UpdateSavedSearchSchema) {}
class PageQueryDto extends createZodDto(CursorPageQuerySchema) {}
class BulkJoinRequestsDto extends createZodDto(BulkJoinRequestsSchema) {}
class UpdateProfileStyleDto extends createZodDto(UpdateProfileStyleSchema) {}

const idPipe = new ZodValidationPipe(UuidSchema);
type RequestWithId = { id?: string };

/** Plans, the member's own subscription, and cancelling it. */
@ApiTags('subscriptions')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller()
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get('subscriptions/plans')
  @ApiOperation({
    summary: 'Paid plans with prices and what they include, what is always free, and the terms',
  })
  async plans() {
    return { data: await this.subscriptions.plans() };
  }

  @Get('me/subscription')
  @ApiOperation({
    summary: 'My tier, what it includes, and my latest subscription with its payments',
  })
  async mine(@CurrentUser() user: AuthUser, @Query() query: SubscriptionViewQueryDto) {
    return { data: await this.subscriptions.mine(user.id, query.returnUrl) };
  }

  @Post('me/subscription')
  @ApiOperation({
    summary:
      'Start a subscription. Returns it waiting for the first payment, with `checkoutUrl`; send a fresh idempotency key per attempt',
  })
  @ApiErrorResponses(400, 404, 409, 503)
  async subscribe(@CurrentUser() user: AuthUser, @Body() body: SubscribeDto) {
    return { data: await this.subscriptions.subscribe(user.id, body) };
  }

  @Post('me/subscription/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Stop renewals. The paid month stays usable to its end; nothing more is charged',
  })
  @ApiErrorResponses(400, 409, 503)
  async cancel(@CurrentUser() user: AuthUser, @Body() body: CancelSubscriptionDto) {
    return { data: await this.subscriptions.cancel(user.id, body.reason) };
  }
}

/** The paid features. Each answers 403 with an `UPGRADE_REQUIRED` detail without the plan. */
@ApiTags('subscriptions')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller()
export class ProFeaturesController {
  constructor(private readonly pro: ProFeaturesService) {}

  @Get('me/saved-searches')
  @ApiOperation({ summary: 'My saved searches (listing and deleting stay free after a plan ends)' })
  async savedSearches(@CurrentUser() user: AuthUser) {
    return { data: await this.pro.listSavedSearches(user.id) };
  }

  @Post('me/saved-searches')
  @ApiOperation({ summary: 'Save a discovery search (Explorer Pro). `alerts` needs trip alerts' })
  @ApiErrorResponses(400, 403, 409)
  async createSavedSearch(@CurrentUser() user: AuthUser, @Body() body: CreateSavedSearchDto) {
    return { data: await this.pro.createSavedSearch(user.id, body) };
  }

  @Patch('me/saved-searches/:id')
  @ApiOperation({ summary: 'Rename a saved search or switch its new-trip alerts on or off' })
  @ApiErrorResponses(400, 403, 404, 409)
  async updateSavedSearch(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: UpdateSavedSearchDto,
  ) {
    return { data: await this.pro.updateSavedSearch(user.id, id, body) };
  }

  @Delete('me/saved-searches/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a saved search' })
  @ApiErrorResponses(404)
  async deleteSavedSearch(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    await this.pro.deleteSavedSearch(user.id, id);
  }

  @Get('me/saved-searches/:id/trips')
  @ApiOperation({ summary: 'Run a saved search: the same results as discovery search' })
  @ApiErrorResponses(400, 403, 404)
  async runSavedSearch(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Query() query: PageQueryDto,
  ) {
    return this.pro.runSavedSearch(user, id, query);
  }

  @Get('me/stats')
  @ApiOperation({
    summary: 'My travel statistics: the basic counts for everyone, the rest with Explorer Pro',
  })
  async stats(@CurrentUser() user: AuthUser) {
    return { data: await this.pro.travelStats(user.id) };
  }

  @Get('me/organiser/insights')
  @ApiOperation({ summary: 'How my trips perform: requests, decisions, fill rate (Organiser Pro)' })
  @ApiErrorResponses(403)
  async insights(@CurrentUser() user: AuthUser) {
    return { data: await this.pro.organiserInsights(user.id) };
  }

  @Post('trips/:id/join-requests/bulk')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Approve or decline up to 50 requests on a trip at once (Organiser Pro). Each one is checked like a single decision',
  })
  @ApiErrorResponses(400, 403)
  async bulk(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: BulkJoinRequestsDto,
    @Req() req: RequestWithId,
  ) {
    return { data: await this.pro.bulkJoinRequests(user, id, body, req.id) };
  }

  @Get('me/profile/style')
  @ApiOperation({ summary: 'My profile accent colour and headline' })
  async style(@CurrentUser() user: AuthUser) {
    return { data: await this.pro.profileStyle(user.id) };
  }

  @Patch('me/profile/style')
  @ApiOperation({
    summary:
      'Set the accent colour (Explorer Pro) or headline (Organiser Pro); clearing either is always allowed',
  })
  @ApiErrorResponses(400, 403)
  async updateStyle(@CurrentUser() user: AuthUser, @Body() body: UpdateProfileStyleDto) {
    return { data: await this.pro.updateProfileStyle(user.id, body) };
  }
}
