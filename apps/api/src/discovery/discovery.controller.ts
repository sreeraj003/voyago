import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  DiscoveryDestinationsQuerySchema,
  DiscoveryNearbyQuerySchema,
  DiscoverySearchQuerySchema,
  DiscoveryTrendingQuerySchema,
} from '@voyago/shared';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { DiscoveryService } from './discovery.service.js';

class SearchQueryDto extends createZodDto(DiscoverySearchQuerySchema) {}
class NearbyQueryDto extends createZodDto(DiscoveryNearbyQuerySchema) {}
class TrendingQueryDto extends createZodDto(DiscoveryTrendingQuerySchema) {}
class DestinationsQueryDto extends createZodDto(DiscoveryDestinationsQuerySchema) {}

const PRIVACY =
  'Only public, published trips that have not departed. Meeting points are rounded to about 1 km for everyone; the coordinates you send are used for this query only and are not stored or logged. Distances are straight-line, not road distances.';

@ApiTags('discovery')
@ApiBearerAuth()
@ApiErrorResponses(401, 400)
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get('search')
  @ApiOperation({
    summary: 'Search trips with filters; sort by relevance, departure or distance',
    description: PRIVACY,
  })
  search(@CurrentUser() user: AuthUser, @Query() query: SearchQueryDto) {
    return this.discovery.search(user, query);
  }

  @Get('nearby')
  @ApiOperation({ summary: 'Trips meeting near a point, closest first', description: PRIVACY })
  nearby(@CurrentUser() user: AuthUser, @Query() query: NearbyQueryDto) {
    return this.discovery.nearby(user, query);
  }

  @Get('trending')
  @ApiOperation({
    summary: 'Upcoming trips people are joining this week',
    description: `Ordered by joins in the last 7 days, then how full, then departure. ${PRIVACY}`,
  })
  trending(@CurrentUser() user: AuthUser, @Query() query: TrendingQueryDto) {
    return this.discovery.trending(user, query);
  }

  @Get('destinations')
  @ApiOperation({ summary: 'Destinations of upcoming public trips, most trips first' })
  destinations(@CurrentUser() user: AuthUser, @Query() query: DestinationsQueryDto) {
    return this.discovery.destinations(user, query);
  }
}
