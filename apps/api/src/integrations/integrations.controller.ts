import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  PlaceDetailsQuerySchema,
  PlaceIdSchema,
  PlaceSearchQuerySchema,
  UploadSignatureRequestSchema,
} from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { CloudinaryService } from './cloudinary.service.js';
import { GoogleMapsService } from './google-maps.service.js';

class PlaceSearchQueryDto extends createZodDto(PlaceSearchQuerySchema) {}
class PlaceDetailsQueryDto extends createZodDto(PlaceDetailsQuerySchema) {}
class UploadSignatureRequestDto extends createZodDto(UploadSignatureRequestSchema) {}

@ApiTags('maps and media')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller()
export class IntegrationsController {
  constructor(
    private readonly maps: GoogleMapsService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  @Get('features')
  @ApiOperation({ summary: 'Optional integrations configured on this server' })
  features() {
    return {
      data: {
        placeSearch: this.maps.enabled,
        routing: this.maps.enabled,
        coverUploads: this.cloudinary.enabled,
      },
    };
  }

  // Each search is billed by Google: keep a per-IP ceiling well above normal typing.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('places/autocomplete')
  @ApiOperation({ summary: 'Search places (Google), biased to Bengaluru, India only' })
  @ApiErrorResponses(400, 503)
  async autocomplete(@Query() query: PlaceSearchQueryDto) {
    return { data: await this.maps.autocomplete(query.q, query.sessionToken) };
  }

  @Get('places/:placeId')
  @ApiOperation({ summary: 'Name, address and coordinates of a place from the search' })
  @ApiErrorResponses(400, 503)
  async place(
    @Param('placeId', new ZodValidationPipe(PlaceIdSchema)) placeId: string,
    @Query() query: PlaceDetailsQueryDto,
  ) {
    return { data: await this.maps.placeDetails(placeId, query.sessionToken) };
  }

  @Post('uploads/cover-signature')
  @ApiOperation({
    summary: 'Signature for uploading one trip cover image directly to Cloudinary (1 hour)',
  })
  @ApiErrorResponses(503)
  coverSignature(@CurrentUser() user: AuthUser) {
    return { data: this.cloudinary.signCoverUpload(user.id) };
  }

  @Post('uploads/signature')
  @ApiOperation({
    summary:
      'Signature for one direct upload to Cloudinary: trip cover, community cover or post photo',
  })
  @ApiErrorResponses(400, 503)
  signature(@CurrentUser() user: AuthUser, @Body() body: UploadSignatureRequestDto) {
    return { data: this.cloudinary.signUpload(user.id, body.kind) };
  }
}
