import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AddOperatorDocumentSchema,
  AnswerQuestionSchema,
  AskQuestionSchema,
  CreateOperatorSchema,
  CreatePackageSchema,
  OperatorQuestionsQuerySchema,
  PackagesQuerySchema,
  UpdateOperatorSchema,
  UpdatePackageSchema,
  UuidSchema,
} from '@voyago/shared';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { OperatorsService } from './operators.service.js';
import { PackagesService } from './packages.service.js';

class CreateOperatorDto extends createZodDto(CreateOperatorSchema) {}
class UpdateOperatorDto extends createZodDto(UpdateOperatorSchema) {}
class AddOperatorDocumentDto extends createZodDto(AddOperatorDocumentSchema) {}
class CreatePackageDto extends createZodDto(CreatePackageSchema) {}
class UpdatePackageDto extends createZodDto(UpdatePackageSchema) {}
class PackagesQueryDto extends createZodDto(PackagesQuerySchema) {}
class OperatorQuestionsQueryDto extends createZodDto(OperatorQuestionsQuerySchema) {}
class AskQuestionDto extends createZodDto(AskQuestionSchema) {}
class AnswerQuestionDto extends createZodDto(AnswerQuestionSchema) {}

const idPipe = new ZodValidationPipe(UuidSchema);

/**
 * The commercial marketplace: a member's own business (`/me/operator`), its packages, and the
 * listings everyone can browse (`/packages`, `/operators/:slug`). Paid experiences only; never
 * passenger transport, and never mixed with free community trips.
 */
@ApiTags('commercial')
@ApiBearerAuth()
@ApiErrorResponses(401)
@Controller()
export class CommercialController {
  constructor(
    private readonly operators: OperatorsService,
    private readonly packages: PackagesService,
  ) {}

  // ── My business ───────────────────────────────────────────────────────────

  @Get('me/operator')
  @ApiOperation({ summary: 'My business profile, documents, status and what is missing' })
  @ApiErrorResponses(404)
  async mine(@CurrentUser() user: AuthUser) {
    return { data: await this.operators.mine(user.id) };
  }

  @Post('me/operator')
  @ApiOperation({
    summary: 'Create my business profile',
    description:
      'One per member. Needs `acceptTerms: true`, a category, address and a business email or phone. Starts unverified; add documents and submit for review.',
  })
  @ApiErrorResponses(400, 409)
  async create(@CurrentUser() user: AuthUser, @Body() body: CreateOperatorDto) {
    return { data: await this.operators.create(user.id, body) };
  }

  @Patch('me/operator')
  @ApiOperation({
    summary: 'Edit my business profile',
    description: 'The legal name and GSTIN of a verified business can only change through support.',
  })
  @ApiErrorResponses(400, 404, 409)
  async update(@CurrentUser() user: AuthUser, @Body() body: UpdateOperatorDto) {
    return { data: await this.operators.update(user.id, body) };
  }

  @Get('me/operator/dashboard')
  @ApiOperation({
    summary: 'Operator dashboard: status, packages, bookings (read-only), questions, performance',
  })
  @ApiErrorResponses(404)
  async dashboard(@CurrentUser() user: AuthUser) {
    return { data: await this.operators.dashboard(user.id) };
  }

  @Post('me/operator/documents/signature')
  @ApiOperation({
    summary: 'Signature for uploading one private verification document (PDF, JPG or PNG, 10 MB)',
  })
  @ApiErrorResponses(503)
  documentSignature(@CurrentUser() user: AuthUser) {
    return { data: this.operators.documentUploadSignature(user.id) };
  }

  @Post('me/operator/documents')
  @ApiOperation({
    summary: 'Add an uploaded verification document',
    description: 'Staff review each document. Uploading one does not verify the business.',
  })
  @ApiErrorResponses(400, 404, 409, 503)
  async addDocument(@CurrentUser() user: AuthUser, @Body() body: AddOperatorDocumentDto) {
    return { data: await this.operators.addDocument(user.id, body) };
  }

  @Delete('me/operator/documents/:id')
  @ApiOperation({ summary: 'Remove a pending or rejected document' })
  @ApiErrorResponses(400, 404, 409)
  async removeDocument(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.operators.removeDocument(user.id, id) };
  }

  @Post('me/operator/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit my business for verification (again after a rejection)' })
  @ApiErrorResponses(404, 409)
  async submit(@CurrentUser() user: AuthUser) {
    return { data: await this.operators.submit(user.id) };
  }

  // ── My packages ───────────────────────────────────────────────────────────

  @Get('me/operator/packages')
  @ApiOperation({ summary: 'All my packages, any status' })
  @ApiErrorResponses(404)
  async listOwn(@CurrentUser() user: AuthUser) {
    return { data: await this.packages.listOwn(user.id) };
  }

  @Post('me/operator/packages')
  @ApiOperation({
    summary: 'Create a package (as a draft)',
    description:
      'Price is the total per person in paise, including taxes (₹1 to ₹10,00,000). Capacity 1–200. Any business can prepare drafts; only verified ones can publish.',
  })
  @ApiErrorResponses(400, 404, 409, 503)
  async createPackage(@CurrentUser() user: AuthUser, @Body() body: CreatePackageDto) {
    return { data: await this.packages.create(user.id, body) };
  }

  @Post('me/operator/packages/photo-signature')
  @ApiOperation({ summary: 'Signature for uploading one package photo' })
  @ApiErrorResponses(503)
  photoSignature(@CurrentUser() user: AuthUser) {
    return { data: this.packages.photoUploadSignature(user.id) };
  }

  @Get('me/operator/packages/:id')
  @ApiOperation({ summary: 'One of my packages, with views, questions and publishing checks' })
  @ApiErrorResponses(400, 404)
  async getOwn(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.packages.getOwn(user.id, id) };
  }

  @Patch('me/operator/packages/:id')
  @ApiOperation({ summary: 'Edit a draft package' })
  @ApiErrorResponses(400, 404, 409, 503)
  async updatePackage(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: UpdatePackageDto,
  ) {
    return { data: await this.packages.update(user.id, id, body) };
  }

  @Post('me/operator/packages/:id/publish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish a draft (verified businesses only)' })
  @ApiErrorResponses(400, 404, 409)
  async publish(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.packages.publish(user.id, id) };
  }

  @Post('me/operator/packages/:id/unpublish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Back to draft, while nobody has booked it' })
  @ApiErrorResponses(400, 404, 409)
  async unpublish(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.packages.unpublish(user.id, id) };
  }

  @Post('me/operator/packages/:id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Take a package off sale for good' })
  @ApiErrorResponses(400, 404, 409)
  async archive(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.packages.archive(user.id, id) };
  }

  @Get('me/operator/questions')
  @ApiOperation({ summary: 'Questions about my packages (`unanswered=true` to filter)' })
  @ApiErrorResponses(404)
  async operatorQuestions(
    @CurrentUser() user: AuthUser,
    @Query() query: OperatorQuestionsQueryDto,
  ) {
    return this.packages.operatorQuestions(user.id, query);
  }

  @Post('package-questions/:id/answer')
  @HttpCode(200)
  @ApiOperation({ summary: 'Answer a question about my package (answers are public)' })
  @ApiErrorResponses(400, 404, 409)
  async answer(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: AnswerQuestionDto,
  ) {
    return { data: await this.packages.answer(user.id, id, body.answer) };
  }

  @Post('package-questions/:id/hide')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hide a spam or abusive question on my package' })
  @ApiErrorResponses(400, 404)
  async hide(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.packages.hideQuestion(user.id, id) };
  }

  // ── Browsing ──────────────────────────────────────────────────────────────

  @Get('packages')
  @ApiOperation({
    summary: 'Paid experiences on sale',
    description:
      'Published packages from verified businesses that have not started. Each is marked `commercial: true`; prices are the total per person.',
  })
  @ApiErrorResponses(400)
  async list(@Query() query: PackagesQueryDto) {
    return this.packages.list(query);
  }

  @Get('packages/:id')
  @ApiOperation({
    summary: 'A package with its full terms',
    description:
      'Total price per person, dates, capacity and seats left, inclusions, exclusions, cancellation terms and the meeting area (about 1 km). Booking opens with the payments milestone.',
  })
  @ApiErrorResponses(400, 404)
  async get(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.packages.get(user, id) };
  }

  @Get('packages/:id/questions')
  @ApiOperation({ summary: 'Answered questions, and my own' })
  @ApiErrorResponses(400, 404)
  async questions(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string) {
    return { data: await this.packages.questions(user, id) };
  }

  @Post('packages/:id/questions')
  @ApiOperation({ summary: 'Ask the business a question (3 per package and 20 a day)' })
  @ApiErrorResponses(400, 403, 404, 429)
  async ask(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body() body: AskQuestionDto,
  ) {
    return { data: await this.packages.ask(user, id, body.question) };
  }

  @Get('operators/:slug')
  @ApiOperation({ summary: 'A verified business and its packages on sale' })
  @ApiErrorResponses(404)
  async operator(
    @CurrentUser() user: AuthUser,
    @Param('slug', new ZodValidationPipe(z.string().trim().min(1).max(80))) slug: string,
  ) {
    return { data: await this.packages.operatorProfile(user, slug) };
  }
}
