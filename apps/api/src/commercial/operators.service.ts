import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type AddOperatorDocumentSchema,
  type CreateOperatorSchema,
  MAX_OPERATOR_DOCUMENTS,
  type MyOperator,
  OPERATOR_TERMS_VERSION,
  type OperatorDashboard,
  type UpdateOperatorSchema,
} from '@voyago/shared';
import { randomBytes } from 'node:crypto';
import { type z } from 'zod';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { CloudinaryService } from '../integrations/cloudinary.service.js';

const DOCUMENT_FORMATS = new Set(['pdf', 'jpg', 'jpeg', 'png']);

const operatorSelect = {
  id: true,
  slug: true,
  displayName: true,
  legalName: true,
  category: true,
  description: true,
  businessEmail: true,
  businessPhone: true,
  website: true,
  gstin: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  verificationStatus: true,
  verificationNote: true,
  submittedAt: true,
  verifiedAt: true,
  termsAcceptedAt: true,
  termsVersion: true,
  documents: {
    select: {
      id: true,
      kind: true,
      fileName: true,
      status: true,
      reviewNote: true,
      reviewedAt: true,
      uploadedAt: true,
    },
    orderBy: [{ uploadedAt: 'asc' }, { kind: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.CommercialOperatorSelect;

type OperatorRow = Prisma.CommercialOperatorGetPayload<{ select: typeof operatorSelect }>;

/** Lower-case words joined by dashes, at most 60 characters. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug.length >= 3 ? slug : `operator-${slug}`.replace(/-+$/g, '');
}

/** What the business profile still needs before it can be submitted for review. */
function missingFor(row: OperatorRow): string[] {
  const missing: string[] = [];
  if (!row.businessEmail && !row.businessPhone) missing.push('A business email or phone number');
  if (!row.addressLine1 || !row.city || !row.state || !row.postalCode) {
    missing.push('The business address');
  }
  if (!row.termsAcceptedAt) missing.push('Accepting the operator terms');
  if (row.documents.filter((d) => d.status !== 'REJECTED').length === 0) {
    missing.push('At least one verification document');
  }
  return missing;
}

function inReview(row: OperatorRow): boolean {
  return row.verificationStatus === 'PENDING' && row.submittedAt !== null;
}

function toMyOperator(row: OperatorRow): MyOperator {
  const missing = missingFor(row);
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    legalName: row.legalName,
    category: row.category,
    description: row.description,
    businessEmail: row.businessEmail,
    businessPhone: row.businessPhone,
    website: row.website,
    gstin: row.gstin,
    address:
      row.addressLine1 && row.city && row.state && row.postalCode
        ? {
            line1: row.addressLine1,
            line2: row.addressLine2,
            city: row.city,
            state: row.state,
            postalCode: row.postalCode,
          }
        : null,
    verificationStatus: row.verificationStatus,
    verificationNote: row.verificationNote,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    termsAcceptedAt: row.termsAcceptedAt?.toISOString() ?? null,
    termsVersion: row.termsVersion,
    documents: row.documents.map((doc) => ({
      ...doc,
      reviewedAt: doc.reviewedAt?.toISOString() ?? null,
      uploadedAt: doc.uploadedAt.toISOString(),
    })),
    missing,
    inReview: inReview(row),
    canSubmit:
      missing.length === 0 &&
      (row.verificationStatus === 'REJECTED' ||
        (row.verificationStatus === 'PENDING' && row.submittedAt === null)),
    canPublish: row.verificationStatus === 'VERIFIED',
  };
}

/**
 * A member's own business on Voyago: the profile, verification documents and submission for
 * review. Uploading documents proves nothing by itself; operations staff review each one and
 * decide (see the admin operators service). One business per member.
 */
@Injectable()
export class OperatorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async mine(userId: string): Promise<MyOperator> {
    return toMyOperator(await this.loadOwn(userId));
  }

  async create(userId: string, input: z.output<typeof CreateOperatorSchema>): Promise<MyOperator> {
    const existing = await this.prisma.commercialOperator.findUnique({
      where: { ownerUserId: userId },
      select: { id: true },
    });
    if (existing) throw new ConflictException('You already have a business profile');
    const base = slugify(input.displayName);
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : `${base.slice(0, 53)}-${randomBytes(3).toString('hex')}`;
      try {
        await this.prisma.$transaction(async (tx) => {
          const created = await tx.commercialOperator.create({
            data: {
              ownerUserId: userId,
              slug,
              ...this.profileData(input),
              termsAcceptedAt: new Date(),
              termsVersion: OPERATOR_TERMS_VERSION,
            },
            select: { id: true },
          });
          await this.audit(tx, userId, created.id, 'operator.create', {
            termsVersion: OPERATOR_TERMS_VERSION,
          });
        });
        return this.mine(userId);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const target = JSON.stringify(error.meta ?? {});
          if (target.includes('owner_user_id') || target.includes('ownerUserId')) {
            throw new ConflictException('You already have a business profile');
          }
          if (target.includes('gstin')) {
            throw new ConflictException('Another business already uses this GSTIN');
          }
          continue; // slug taken: try another
        }
        throw error;
      }
    }
    throw new ConflictException('Choose a different business name');
  }

  /**
   * Legal details (legal name, GSTIN) of a verified business are fixed: changing them needs a new
   * review, which goes through Voyago support.
   */
  async update(userId: string, input: z.output<typeof UpdateOperatorSchema>): Promise<MyOperator> {
    const operator = await this.loadOwn(userId);
    if (operator.verificationStatus === 'VERIFIED') {
      const locked = (['legalName', 'gstin'] as const).filter(
        (key) => input[key] !== undefined && input[key] !== operator[key],
      );
      if (locked.length > 0) {
        throw new ConflictException(
          'The legal name and GSTIN of a verified business can only be changed through support',
        );
      }
    }
    try {
      await this.prisma.commercialOperator.update({
        where: { id: operator.id },
        data: this.profileData(input),
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Another business already uses this GSTIN');
      }
      throw error;
    }
    return this.mine(userId);
  }

  documentUploadSignature(userId: string) {
    return this.cloudinary.signUpload(userId, 'operator-document');
  }

  /** Records an uploaded document after checking it is the member's own, real upload. */
  async addDocument(
    userId: string,
    input: z.output<typeof AddOperatorDocumentSchema>,
  ): Promise<MyOperator> {
    const operator = await this.loadOwn(userId);
    if (operator.documents.length >= MAX_OPERATOR_DOCUMENTS) {
      throw new ConflictException(
        `You can keep up to ${MAX_OPERATOR_DOCUMENTS} documents. Remove one first.`,
      );
    }
    const duplicate = await this.prisma.operatorDocument.count({
      where: { operatorId: operator.id, storageKey: input.documentId },
    });
    if (duplicate > 0) {
      throw new ConflictException('This document is already added');
    }
    const stored = await this.cloudinary.assertOwnUpload(
      userId,
      input.documentId,
      'operator-document',
      'documentId',
    );
    const format = stored.format ?? 'pdf';
    if (!DOCUMENT_FORMATS.has(format)) {
      throw new HttpException(
        {
          message: 'Validation failed',
          details: [{ path: 'documentId', message: 'Upload a PDF, JPG or PNG file' }],
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const doc = await tx.operatorDocument.create({
        data: {
          operatorId: operator.id,
          kind: input.kind,
          storageKey: input.documentId,
          format,
          fileName: input.fileName,
        },
        select: { id: true },
      });
      await this.audit(tx, userId, operator.id, 'operator.document_add', {
        documentId: doc.id,
        kind: input.kind,
      });
    });
    return this.mine(userId);
  }

  /** Documents staff accepted stay; pending or rejected ones can be removed. */
  async removeDocument(userId: string, documentId: string): Promise<MyOperator> {
    const operator = await this.loadOwn(userId);
    const doc = operator.documents.find((d) => d.id === documentId);
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.status === 'ACCEPTED') {
      throw new ConflictException('Accepted documents stay on file');
    }
    await this.prisma.operatorDocument.delete({ where: { id: documentId } });
    return this.mine(userId);
  }

  /** Sends the business for review: first time, or again after a rejection. */
  async submit(userId: string): Promise<MyOperator> {
    const operator = await this.loadOwn(userId);
    if (operator.verificationStatus === 'VERIFIED') {
      throw new ConflictException('Your business is already verified');
    }
    if (operator.verificationStatus === 'SUSPENDED') {
      throw new ConflictException('Your business is suspended. Contact Voyago support.');
    }
    if (inReview(operator)) throw new ConflictException('Your business is already in review');
    const missing = missingFor(operator);
    if (missing.length > 0) {
      throw new ConflictException(`Before submitting, add: ${missing.join('; ')}`);
    }
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.commercialOperator.updateMany({
        where: { id: operator.id, verificationStatus: operator.verificationStatus },
        data: { verificationStatus: 'PENDING', submittedAt: new Date() },
      });
      if (changed.count === 0) {
        throw new ConflictException('Your business changed. Reload and try again.');
      }
      await this.audit(tx, userId, operator.id, 'operator.submit', {
        from: operator.verificationStatus,
      });
    });
    return this.mine(userId);
  }

  async dashboard(userId: string): Promise<OperatorDashboard> {
    const operator = await this.loadOwn(userId);
    const now = new Date();
    const [byStatus, upcoming, views, bookings, answered, unanswered] = await Promise.all([
      this.prisma.commercialPackage.groupBy({
        by: ['status'],
        where: { operatorId: operator.id },
        _count: { _all: true },
      }),
      this.prisma.commercialPackage.count({
        where: { operatorId: operator.id, status: 'PUBLISHED', startsAt: { gt: now } },
      }),
      this.prisma.commercialPackage.aggregate({
        where: { operatorId: operator.id },
        _sum: { viewCount: true },
      }),
      this.prisma.booking.groupBy({
        by: ['status'],
        where: { package: { operatorId: operator.id } },
        _count: { _all: true },
        _sum: { seats: true },
      }),
      this.prisma.packageQuestion.count({
        where: { package: { operatorId: operator.id }, hiddenAt: null, answeredAt: { not: null } },
      }),
      this.prisma.packageQuestion.count({
        where: { package: { operatorId: operator.id }, hiddenAt: null, answeredAt: null },
      }),
    ]);
    const count = (status: string) => byStatus.find((g) => g.status === status)?._count._all ?? 0;
    const confirmed = bookings.filter((b) => b.status === 'CONFIRMED');
    const asked = answered + unanswered;
    return {
      operator: {
        displayName: operator.displayName,
        slug: operator.slug,
        verificationStatus: operator.verificationStatus,
        verificationNote: operator.verificationNote,
        inReview: inReview(operator),
        canPublish: operator.verificationStatus === 'VERIFIED',
      },
      packages: {
        draft: count('DRAFT'),
        published: count('PUBLISHED'),
        upcoming,
        suspended: count('SUSPENDED'),
        archived: count('ARCHIVED'),
      },
      bookings: {
        total: bookings.reduce((sum, b) => sum + b._count._all, 0),
        confirmed: confirmed.reduce((sum, b) => sum + b._count._all, 0),
        seats: confirmed.reduce((sum, b) => sum + (b._sum.seats ?? 0), 0),
      },
      questions: { unanswered, answered },
      performance: {
        listingViews: views._sum.viewCount ?? 0,
        answerRatePercent: asked === 0 ? null : Math.round((answered / asked) * 100),
      },
    };
  }

  /** The member's business, or 404 when they have none. */
  async loadOwn(userId: string): Promise<OperatorRow> {
    const row = await this.prisma.commercialOperator.findUnique({
      where: { ownerUserId: userId },
      select: operatorSelect,
    });
    if (!row) throw new NotFoundException('You have no business profile yet');
    return row;
  }

  private profileData(
    input: Partial<z.output<typeof CreateOperatorSchema>>,
  ): Omit<Prisma.CommercialOperatorUncheckedCreateInput, 'ownerUserId' | 'slug'> {
    const data: Record<string, unknown> = {};
    const copy = [
      'displayName',
      'legalName',
      'category',
      'description',
      'businessEmail',
      'businessPhone',
      'website',
      'gstin',
    ] as const;
    for (const key of copy) {
      if (input[key] !== undefined) data[key] = input[key] === '' ? null : input[key];
    }
    if (input.address) {
      data.addressLine1 = input.address.line1;
      data.addressLine2 = input.address.line2 || null;
      data.city = input.address.city;
      data.state = input.address.state;
      data.postalCode = input.address.postalCode;
    }
    return data as Omit<Prisma.CommercialOperatorUncheckedCreateInput, 'ownerUserId' | 'slug'>;
  }

  private audit(
    tx: Prisma.TransactionClient,
    userId: string,
    operatorId: string,
    action: string,
    metadata: Prisma.InputJsonObject,
  ) {
    return tx.auditLog.create({
      data: {
        actorId: userId,
        actorType: 'USER',
        action,
        entityType: 'operator',
        entityId: operatorId,
        metadata,
      },
    });
  }
}
