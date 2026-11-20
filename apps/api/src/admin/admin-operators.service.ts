import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  type AdminOperatorDetail,
  type AdminOperatorsQuerySchema,
  type AdminOperatorSummary,
  type DocumentLink,
  hasPermission,
  type ReviewDocumentSchema,
  type SetOperatorStatusSchema,
} from '@voyago/shared';
import { type z } from 'zod';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';
import { CloudinaryService } from '../integrations/cloudinary.service.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { recordAudit } from './audit.js';
import { staffPerson, staffPersonSelect } from './people.js';
import { type Actor } from './permissions.js';

/** Document links expire quickly; staff open a new one each time. */
const DOCUMENT_LINK_TTL_SECONDS = 5 * 60;

const operatorSelect = {
  id: true,
  displayName: true,
  legalName: true,
  slug: true,
  verificationStatus: true,
  submittedAt: true,
  createdAt: true,
  ownerUserId: true,
  owner: { select: staffPersonSelect },
  documents: { select: { status: true } },
} as const satisfies Prisma.CommercialOperatorSelect;

type OperatorRow = Prisma.CommercialOperatorGetPayload<{ select: typeof operatorSelect }>;

function toSummary(row: OperatorRow): AdminOperatorSummary {
  return {
    id: row.id,
    displayName: row.displayName,
    legalName: row.legalName,
    slug: row.slug,
    owner: staffPerson(row.owner),
    verificationStatus: row.verificationStatus,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    documentCount: row.documents.length,
    pendingDocumentCount: row.documents.filter((d) => d.status === 'PENDING').length,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Operator verification is always a person's decision: staff review each document, then set the
 * status with a reason. VERIFIED needs every document reviewed and at least one accepted, and
 * nothing ever marks an operator verified automatically. Documents are private files opened
 * through five-minute links, and every opening is audited.
 */
@Injectable()
export class AdminOperatorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly overview: AdminOverviewService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async list(query: z.output<typeof AdminOperatorsQuerySchema>) {
    const cursor = decodeCursor(query.cursor);
    const q = query.q?.trim();
    const rows = await this.prisma.commercialOperator.findMany({
      where: {
        ...(query.status ? { verificationStatus: query.status } : {}),
        AND: [
          q
            ? {
                OR: [
                  { displayName: { contains: q, mode: 'insensitive' } },
                  { legalName: { contains: q, mode: 'insensitive' } },
                  { slug: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {},
          cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      select: operatorSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toSummary), page: page.page };
  }

  async get(actor: Actor, id: string): Promise<AdminOperatorDetail> {
    const row = await this.prisma.commercialOperator.findUnique({
      where: { id },
      select: {
        ...operatorSelect,
        gstin: true,
        verificationNote: true,
        verifiedAt: true,
        verifiedBy: { select: staffPersonSelect },
        documents: {
          select: {
            id: true,
            kind: true,
            fileName: true,
            status: true,
            reviewNote: true,
            reviewedAt: true,
            uploadedAt: true,
            reviewedBy: { select: staffPersonSelect },
          },
          orderBy: { uploadedAt: 'asc' },
        },
      },
    });
    if (!row) throw new NotFoundException('Operator not found');
    const role = actor.user.role;
    const canVerify = hasPermission(role, 'operators.verify') && row.ownerUserId !== actor.user.id;
    const actions: AdminOperatorDetail['actions'] = [];
    if (canVerify) actions.push('review_documents', 'set_status');
    if (hasPermission(role, 'operators.documents')) actions.push('open_documents');
    return {
      ...toSummary(row),
      gstin: hasPermission(role, 'operators.documents') ? row.gstin : null,
      verificationNote: row.verificationNote,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      verifiedBy: row.verifiedBy ? staffPerson(row.verifiedBy) : null,
      documents: row.documents.map((doc) => ({
        id: doc.id,
        kind: doc.kind,
        fileName: doc.fileName,
        status: doc.status,
        reviewNote: doc.reviewNote,
        reviewedBy: doc.reviewedBy ? staffPerson(doc.reviewedBy) : null,
        reviewedAt: doc.reviewedAt?.toISOString() ?? null,
        uploadedAt: doc.uploadedAt.toISOString(),
      })),
      history: await this.overview.historyOf('operator', id),
      actions,
    };
  }

  /** A five-minute link to one document. Recorded in the audit log before it is handed out. */
  async documentLink(actor: Actor, operatorId: string, documentId: string): Promise<DocumentLink> {
    const doc = await this.prisma.operatorDocument.findFirst({
      where: { id: documentId, operatorId },
      select: { id: true, storageKey: true, format: true, kind: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    const link = this.cloudinary.privateDownloadUrl(
      doc.storageKey,
      doc.format,
      DOCUMENT_LINK_TTL_SECONDS,
    );
    if (!link) throw new ServiceUnavailableException('Document storage is not configured');
    await this.prisma.$transaction(async (tx) => {
      await recordAudit(tx, actor, {
        action: 'operator.document_view',
        entityType: 'operator',
        entityId: operatorId,
        metadata: { documentId: doc.id, kind: doc.kind },
      });
    });
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  async reviewDocument(
    actor: Actor,
    operatorId: string,
    documentId: string,
    input: z.output<typeof ReviewDocumentSchema>,
  ): Promise<AdminOperatorDetail> {
    await this.assertNotOwnOperator(actor, operatorId);
    const doc = await this.prisma.operatorDocument.findFirst({
      where: { id: documentId, operatorId },
      select: { status: true, kind: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.operatorDocument.update({
        where: { id: documentId },
        data: {
          status: input.status,
          reviewNote: input.note ?? null,
          reviewedById: actor.user.id,
          reviewedAt: new Date(),
        },
      });
      await recordAudit(tx, actor, {
        action: 'operator.document_review',
        entityType: 'operator',
        entityId: operatorId,
        reason: input.note ?? null,
        metadata: { documentId, kind: doc.kind, from: doc.status, to: input.status },
      });
    });
    return this.get(actor, operatorId);
  }

  async setStatus(
    actor: Actor,
    id: string,
    input: z.output<typeof SetOperatorStatusSchema>,
  ): Promise<AdminOperatorDetail> {
    const operator = await this.assertNotOwnOperator(actor, id);
    if (operator.verificationStatus === input.status) {
      throw new ConflictException(`The operator is already ${input.status.toLowerCase()}`);
    }
    if (input.status === 'VERIFIED') {
      const docs = await this.prisma.operatorDocument.findMany({
        where: { operatorId: id },
        select: { status: true },
      });
      if (docs.some((d) => d.status === 'PENDING')) {
        throw new ConflictException('Review every document before verifying');
      }
      if (!docs.some((d) => d.status === 'ACCEPTED')) {
        throw new ConflictException('Accept at least one document before verifying');
      }
    }
    const verified = input.status === 'VERIFIED';
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.commercialOperator.updateMany({
        where: { id, verificationStatus: operator.verificationStatus },
        data: {
          verificationStatus: input.status,
          verificationNote: input.reason,
          verifiedAt: verified ? new Date() : null,
          verifiedById: verified ? actor.user.id : null,
        },
      });
      if (changed.count === 0) {
        throw new ConflictException('The operator changed. Reload and try again.');
      }
      await recordAudit(tx, actor, {
        action: `operator.${input.status.toLowerCase()}`,
        entityType: 'operator',
        entityId: id,
        reason: input.reason,
        metadata: { from: operator.verificationStatus, to: input.status },
      });
    });
    return this.get(actor, id);
  }

  /** Nobody reviews an operator they own. */
  private async assertNotOwnOperator(actor: Actor, id: string) {
    const operator = await this.prisma.commercialOperator.findUnique({
      where: { id },
      select: { ownerUserId: true, verificationStatus: true },
    });
    if (!operator) throw new NotFoundException('Operator not found');
    if (operator.ownerUserId === actor.user.id) {
      throw new ForbiddenException('You cannot review your own operator account');
    }
    return operator;
  }
}
