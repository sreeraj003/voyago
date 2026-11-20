import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminOperatorsQuerySchema,
  AdminReportsQuerySchema,
  AdminTripsQuerySchema,
  AdminUsersQuerySchema,
  AssignReportSchema,
  AuditQuerySchema,
  ReasonBodySchema,
  ResolveReportSchema,
  ReviewDocumentSchema,
  SetOperatorStatusSchema,
  SetRoleSchema,
  TriageReportSchema,
  UuidSchema,
} from '@voyago/shared';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { AdminContentService } from './admin-content.service.js';
import { AdminOperatorsService } from './admin-operators.service.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { AdminReportsService } from './admin-reports.service.js';
import { AdminUsersService } from './admin-users.service.js';
import { type Actor, CurrentActor, PermissionGuard, RequirePermission } from './permissions.js';

class ReasonDto extends createZodDto(ReasonBodySchema) {}
class AuditQueryDto extends createZodDto(AuditQuerySchema) {}
class UsersQueryDto extends createZodDto(AdminUsersQuerySchema) {}
class SetRoleDto extends createZodDto(SetRoleSchema) {}
class TripsQueryDto extends createZodDto(AdminTripsQuerySchema) {}
class ReportsQueryDto extends createZodDto(AdminReportsQuerySchema) {}
class AssignReportDto extends createZodDto(AssignReportSchema) {}
class TriageReportDto extends createZodDto(TriageReportSchema) {}
class ResolveReportDto extends createZodDto(ResolveReportSchema) {}
class OperatorsQueryDto extends createZodDto(AdminOperatorsQuerySchema) {}
class ReviewDocumentDto extends createZodDto(ReviewDocumentSchema) {}
class SetOperatorStatusDto extends createZodDto(SetOperatorStatusSchema) {}

const idPipe = new ZodValidationPipe(UuidSchema);

/**
 * Staff-only routes for the admin app. Every route declares the permission it needs and
 * PermissionGuard checks it against the caller's current role (members get 403).
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(PermissionGuard)
@ApiErrorResponses(401, 403)
@Controller('admin')
export class AdminOverviewController {
  constructor(private readonly overview: AdminOverviewService) {}

  @Get('me')
  @RequirePermission('dashboard.view')
  @ApiOperation({ summary: 'The signed-in staff member, their role and permissions' })
  async me(@CurrentActor() actor: Actor) {
    return { data: await this.overview.me(actor.user) };
  }

  @Get('dashboard')
  @RequirePermission('dashboard.view')
  @ApiOperation({ summary: 'Platform metrics: members, trips, reports, operator queue' })
  async dashboard() {
    return { data: await this.overview.dashboard() };
  }

  @Get('staff')
  @RequirePermission('reports.manage')
  @ApiOperation({ summary: 'Staff who can be assigned reports' })
  async staff() {
    return { data: await this.overview.staff() };
  }

  @Get('audit')
  @RequirePermission('audit.read')
  @ApiOperation({ summary: 'The audit log of privileged actions, newest first' })
  @ApiErrorResponses(400)
  async audit(@Query() query: AuditQueryDto) {
    return this.overview.audit(query);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(PermissionGuard)
@ApiErrorResponses(401, 403)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @RequirePermission('users.read')
  @ApiOperation({ summary: 'Search members by username, name, exact email or id' })
  @ApiErrorResponses(400)
  async list(@Query() query: UsersQueryDto) {
    return this.users.list(query);
  }

  @Get(':id')
  @RequirePermission('users.read')
  @ApiOperation({ summary: 'A member: status, verification, reports and moderation history' })
  @ApiErrorResponses(404)
  async get(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string) {
    return { data: await this.users.get(actor, id) };
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermission('users.suspend')
  @ApiOperation({
    summary: 'Suspend a member',
    description: 'Signs them out everywhere at once. Staff accounts need a super admin.',
  })
  @ApiErrorResponses(400, 404, 409)
  async suspend(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return { data: await this.users.suspend(actor, id, body.reason) };
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermission('users.suspend')
  @ApiOperation({ summary: 'Restore a suspended member' })
  @ApiErrorResponses(400, 404, 409)
  async restore(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return { data: await this.users.restore(actor, id, body.reason) };
  }

  @Post(':id/role')
  @HttpCode(200)
  @RequirePermission('users.role')
  @ApiOperation({ summary: 'Grant or remove a staff role (super admins only)' })
  @ApiErrorResponses(400, 404, 409)
  async setRole(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: SetRoleDto,
  ) {
    return { data: await this.users.setRole(actor, id, body.role, body.reason) };
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(PermissionGuard)
@ApiErrorResponses(401, 403)
@Controller('admin')
export class AdminContentController {
  constructor(private readonly content: AdminContentService) {}

  @Get('trips')
  @RequirePermission('trips.read')
  @ApiOperation({ summary: 'Search trips; filter by status, hidden or reported' })
  @ApiErrorResponses(400)
  async trips(@Query() query: TripsQueryDto) {
    return this.content.listTrips(query);
  }

  @Get('trips/:id')
  @RequirePermission('trips.read')
  @ApiOperation({ summary: 'A trip with its reports and moderation history' })
  @ApiErrorResponses(404)
  async trip(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string) {
    return { data: await this.content.getTrip(actor, id) };
  }

  @Post('trips/:id/hide')
  @HttpCode(200)
  @RequirePermission('content.moderate')
  @ApiOperation({
    summary: 'Hide a trip',
    description: 'Removed from discovery, feeds and communities; its people can still see it.',
  })
  @ApiErrorResponses(400, 404, 409)
  async hide(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return { data: await this.content.hideTrip(actor, id, body.reason) };
  }

  @Post('trips/:id/unhide')
  @HttpCode(200)
  @RequirePermission('content.moderate')
  @ApiOperation({ summary: 'Show a hidden trip again' })
  @ApiErrorResponses(400, 404, 409)
  async unhide(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return { data: await this.content.unhideTrip(actor, id, body.reason) };
  }

  @Post('trips/:id/cancel')
  @HttpCode(200)
  @RequirePermission('content.moderate')
  @ApiOperation({ summary: 'Cancel an unsafe or fraudulent trip (participants see the reason)' })
  @ApiErrorResponses(400, 404, 409)
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return { data: await this.content.cancelTrip(actor, id, body.reason) };
  }

  @Post('posts/:id/remove')
  @HttpCode(204)
  @RequirePermission('content.moderate')
  @ApiOperation({ summary: 'Remove a post' })
  @ApiErrorResponses(400, 404, 409)
  async removePost(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    await this.content.removePost(actor, id, body.reason);
  }

  @Post('messages/:id/remove')
  @HttpCode(204)
  @RequirePermission('content.moderate')
  @ApiOperation({ summary: 'Remove a chat message for everyone' })
  @ApiErrorResponses(400, 404, 409)
  async removeMessage(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    await this.content.removeMessage(actor, id, body.reason);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(PermissionGuard)
@ApiErrorResponses(401, 403)
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly reports: AdminReportsService) {}

  @Get()
  @RequirePermission('reports.read')
  @ApiOperation({ summary: 'The report queue (most severe, then oldest first) or history' })
  @ApiErrorResponses(400)
  async list(@CurrentActor() actor: Actor, @Query() query: ReportsQueryDto) {
    return this.reports.list(actor, query);
  }

  @Get(':id')
  @RequirePermission('reports.read')
  @ApiOperation({ summary: 'A report with the reported content, related reports and history' })
  @ApiErrorResponses(404)
  async get(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string) {
    return { data: await this.reports.get(actor, id) };
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission('reports.manage')
  @ApiOperation({ summary: 'Assign to a moderator (or unassign); an open report moves to review' })
  @ApiErrorResponses(400, 404, 409)
  async assign(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: AssignReportDto,
  ) {
    return { data: await this.reports.assign(actor, id, body.assigneeId) };
  }

  @Patch(':id')
  @RequirePermission('reports.manage')
  @ApiOperation({ summary: 'Change severity or evidence references' })
  @ApiErrorResponses(400, 404, 409)
  async triage(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: TriageReportDto,
  ) {
    return { data: await this.reports.triage(actor, id, body) };
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermission('reports.manage')
  @ApiOperation({ summary: 'Resolve as actioned or dismissed, with a note' })
  @ApiErrorResponses(400, 404, 409)
  async resolve(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: ResolveReportDto,
  ) {
    return { data: await this.reports.resolve(actor, id, body) };
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermission('reports.manage')
  @ApiOperation({ summary: 'Reopen a resolved report' })
  @ApiErrorResponses(400, 404, 409)
  async reopen(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return { data: await this.reports.reopen(actor, id, body.reason) };
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(PermissionGuard)
@ApiErrorResponses(401, 403)
@Controller('admin/operators')
export class AdminOperatorsController {
  constructor(private readonly operators: AdminOperatorsService) {}

  @Get()
  @RequirePermission('operators.read')
  @ApiOperation({ summary: 'Operators, filtered by verification status' })
  @ApiErrorResponses(400)
  async list(@Query() query: OperatorsQueryDto) {
    return this.operators.list(query);
  }

  @Get(':id')
  @RequirePermission('operators.read')
  @ApiOperation({ summary: 'An operator with document metadata and review history' })
  @ApiErrorResponses(404)
  async get(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string) {
    return { data: await this.operators.get(actor, id) };
  }

  @Post(':id/documents/:documentId/link')
  @HttpCode(200)
  @RequirePermission('operators.documents')
  @ApiOperation({
    summary: 'A five-minute link to open one document',
    description: 'Each link handed out is recorded in the audit log.',
  })
  @ApiErrorResponses(404, 503)
  async documentLink(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Param('documentId', idPipe) documentId: string,
  ) {
    return { data: await this.operators.documentLink(actor, id, documentId) };
  }

  @Post(':id/documents/:documentId/review')
  @HttpCode(200)
  @RequirePermission('operators.verify')
  @ApiOperation({ summary: 'Accept or reject a document' })
  @ApiErrorResponses(400, 404)
  async reviewDocument(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Param('documentId', idPipe) documentId: string,
    @Body() body: ReviewDocumentDto,
  ) {
    return { data: await this.operators.reviewDocument(actor, id, documentId, body) };
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('operators.verify')
  @ApiOperation({
    summary: 'Verify, reject or suspend an operator',
    description: 'Verifying needs every document reviewed and at least one accepted.',
  })
  @ApiErrorResponses(400, 404, 409)
  async setStatus(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body() body: SetOperatorStatusDto,
  ) {
    return { data: await this.operators.setStatus(actor, id, body) };
  }
}
