import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type CreatePackageSchema,
  type GeoPoint,
  hasPermission,
  type OperatorQuestionsQuerySchema,
  type OwnPackage,
  type PackageCard,
  type PackageDetail,
  type PackageQuestion,
  packageRuleIssues,
  type PackagesQuerySchema,
  type PublicOperator,
  type RefundTier,
  RefundTiersSchema,
  type UpdatePackageSchema,
} from '@voyago/shared';
import { type z } from 'zod';
import { type AuthUser } from '../common/auth/current-user.decorator.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { setPointSql } from '../database/geo.js';
import { Prisma } from '../generated/prisma/client.js';
import { CloudinaryService } from '../integrations/cloudinary.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RedisService } from '../redis/redis.service.js';
import { blockedIds } from '../social/blocks.js';
import { PaymentGateway } from '../payments/payment-gateway.js';
import { OperatorsService } from './operators.service.js';

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Questions a member may ask: per package and in total, each day. */
const QUESTIONS_PER_PACKAGE_PER_DAY = 3;
const QUESTIONS_PER_DAY = 20;
/** Bookings that hold seats (the booking milestone creates them). */
const HOLDING: Prisma.BookingWhereInput['status'] = { in: ['PENDING_PAYMENT', 'CONFIRMED'] };

const packageSelect = {
  id: true,
  operatorId: true,
  mode: true,
  activityType: true,
  title: true,
  description: true,
  destinationName: true,
  durationDays: true,
  pricePaise: true,
  currency: true,
  maxGroupSize: true,
  inclusions: true,
  exclusions: true,
  cancellationPolicy: true,
  refundTiers: true,
  status: true,
  coverImageKey: true,
  imageKeys: true,
  startsAt: true,
  endsAt: true,
  meetingPointName: true,
  viewCount: true,
  suspendedReason: true,
  publishedAt: true,
  createdAt: true,
  operator: {
    select: {
      slug: true,
      displayName: true,
      category: true,
      verificationStatus: true,
      ownerUserId: true,
    },
  },
} as const satisfies Prisma.CommercialPackageSelect;

type PackageRow = Prisma.CommercialPackageGetPayload<{ select: typeof packageSelect }>;
type Points = { destination: GeoPoint | null; meetingPoint: GeoPoint | null };

/** What anyone signed in may see: published, by a verified business, not yet started. */
const LISTED = (now: Date): Prisma.CommercialPackageWhereInput => ({
  status: 'PUBLISHED',
  operator: { verificationStatus: 'VERIFIED' },
  startsAt: { gt: now },
});

/** The stored refund schedule (validated on the way in; re-checked here). */
export function tiersOf(row: { refundTiers: unknown }): RefundTier[] {
  const parsed = RefundTiersSchema.safeParse(row.refundTiers);
  return parsed.success ? parsed.data : [];
}

/** Calendar days in India covered by the dates, counting both ends. */
export function durationDays(startsAt: Date, endsAt: Date): number {
  const day = (d: Date) => Math.floor((d.getTime() + IST_OFFSET_MS) / DAY_MS);
  return Math.max(1, day(endsAt) - day(startsAt) + 1);
}

/** Rounds to about 1 km, so the exact meeting spot is not given out before a booking. */
const approximate = (point: GeoPoint): GeoPoint => ({
  latitude: Math.round(point.latitude * 100) / 100,
  longitude: Math.round(point.longitude * 100) / 100,
});

/**
 * Paid experiences sold by verified businesses. Only a verified operator can publish (checked
 * here and by a database trigger); a published listing always has its dates, total price,
 * inclusions, exclusions, meeting point and cancellation terms (database check). Listings are
 * kept apart from free community trips: they are never trips, carry no shared-cost estimate, and
 * are always marked commercial.
 */
@Injectable()
export class PackagesService {
  private readonly logger = new Logger(PackagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: OperatorsService,
    private readonly cloudinary: CloudinaryService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
    private readonly gateway: PaymentGateway,
  ) {}

  // ── Operator: managing packages ───────────────────────────────────────────

  async listOwn(userId: string): Promise<OwnPackage[]> {
    const operator = await this.operators.loadOwn(userId);
    const rows = await this.prisma.commercialPackage.findMany({
      where: { operatorId: operator.id },
      select: packageSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return this.ownViews(rows);
  }

  async getOwn(userId: string, id: string): Promise<OwnPackage> {
    const row = await this.loadOwnPackage(userId, id);
    const [view] = await this.ownViews([row]);
    return view!;
  }

  photoUploadSignature(userId: string) {
    return this.cloudinary.signUpload(userId, 'package-photo');
  }

  /** Any operator can prepare drafts; publishing waits for verification. */
  async create(userId: string, input: z.output<typeof CreatePackageSchema>): Promise<OwnPackage> {
    const operator = await this.operators.loadOwn(userId);
    if (operator.verificationStatus === 'SUSPENDED') {
      throw new ConflictException('Your business is suspended. Contact Voyago support.');
    }
    await this.assertPhotos(userId, input.photoIds, []);
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.commercialPackage.create({
        data: {
          operatorId: operator.id,
          mode: input.mode,
          activityType: input.activityType,
          title: input.title,
          description: input.description || null,
          destinationName: input.destination.name,
          meetingPointName: input.meetingPoint.name,
          startsAt,
          endsAt,
          durationDays: durationDays(startsAt, endsAt),
          pricePaise: input.pricePaise,
          currency: input.currency,
          maxGroupSize: input.capacity,
          inclusions: input.inclusions,
          exclusions: input.exclusions,
          cancellationPolicy: input.cancellationPolicy,
          refundTiers: input.refundTiers,
          imageKeys: input.photoIds,
          coverImageKey: input.photoIds[0] ?? null,
        },
        select: { id: true },
      });
      await tx.$executeRaw(
        setPointSql('commercial_packages', 'destination', created.id, input.destination.point),
      );
      await tx.$executeRaw(
        setPointSql('commercial_packages', 'meeting_point', created.id, input.meetingPoint.point),
      );
      return created.id;
    });
    return this.getOwn(userId, id);
  }

  /** Drafts only: unpublish a listing first (allowed while nobody has booked it). */
  async update(
    userId: string,
    id: string,
    input: z.output<typeof UpdatePackageSchema>,
  ): Promise<OwnPackage> {
    const row = await this.loadOwnPackage(userId, id);
    if (row.status !== 'DRAFT') {
      throw new ConflictException(
        row.status === 'PUBLISHED'
          ? 'Unpublish this package to edit it'
          : 'This package can no longer be edited',
      );
    }
    const merged = {
      mode: input.mode ?? row.mode,
      activityType: input.activityType ?? row.activityType,
      startsAt: input.startsAt ?? row.startsAt?.toISOString(),
      endsAt: input.endsAt ?? row.endsAt?.toISOString(),
    };
    const issues = packageRuleIssues(merged).filter(
      // An unchanged start that has passed is reported at publishing time instead.
      (issue) => issue.path !== 'startsAt' || input.startsAt !== undefined,
    );
    if (issues.length > 0) {
      throw new HttpException(
        { message: 'Validation failed', details: issues },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (input.photoIds) await this.assertPhotos(userId, input.photoIds, row.imageKeys);
    const startsAt = merged.startsAt ? new Date(merged.startsAt) : null;
    const endsAt = merged.endsAt ? new Date(merged.endsAt) : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.commercialPackage.update({
        where: { id },
        data: {
          mode: input.mode,
          activityType: input.activityType,
          title: input.title,
          description: input.description === undefined ? undefined : input.description || null,
          destinationName: input.destination?.name,
          meetingPointName: input.meetingPoint?.name,
          startsAt: input.startsAt ? startsAt : undefined,
          endsAt: input.endsAt ? endsAt : undefined,
          durationDays: startsAt && endsAt ? durationDays(startsAt, endsAt) : undefined,
          pricePaise: input.pricePaise,
          maxGroupSize: input.capacity,
          inclusions: input.inclusions,
          exclusions: input.exclusions,
          cancellationPolicy: input.cancellationPolicy,
          refundTiers: input.refundTiers,
          imageKeys: input.photoIds,
          coverImageKey: input.photoIds ? (input.photoIds[0] ?? null) : undefined,
        },
      });
      if (input.destination) {
        await tx.$executeRaw(
          setPointSql('commercial_packages', 'destination', id, input.destination.point),
        );
      }
      if (input.meetingPoint) {
        await tx.$executeRaw(
          setPointSql('commercial_packages', 'meeting_point', id, input.meetingPoint.point),
        );
      }
    });
    return this.getOwn(userId, id);
  }

  async publish(userId: string, id: string): Promise<OwnPackage> {
    const row = await this.loadOwnPackage(userId, id);
    if (row.operator.verificationStatus !== 'VERIFIED') {
      throw new ConflictException(
        'Only verified businesses can publish. Your package stays a draft until Voyago verifies your business.',
      );
    }
    if (row.status !== 'DRAFT') {
      throw new ConflictException(
        row.status === 'PUBLISHED'
          ? 'This package is already published'
          : 'This package cannot be published',
      );
    }
    const issues = this.publishIssues(row);
    if (issues.length > 0) throw new ConflictException(`Before publishing: ${issues.join('; ')}`);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.commercialPackage.updateMany({
        where: { id, status: 'DRAFT' },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      if (changed.count === 0) {
        throw new ConflictException('The package changed. Reload and try again.');
      }
      await this.audit(tx, userId, id, 'package.publish', {
        pricePaise: row.pricePaise,
        capacity: row.maxGroupSize,
      });
    });
    return this.getOwn(userId, id);
  }

  /** Back to draft for changes, only while nobody holds a booking on it. */
  async unpublish(userId: string, id: string): Promise<OwnPackage> {
    const row = await this.loadOwnPackage(userId, id);
    if (row.status !== 'PUBLISHED') throw new ConflictException('This package is not published');
    await this.assertNoBookings(id, 'People have booked this package, so it cannot be changed');
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.commercialPackage.updateMany({
        where: { id, status: 'PUBLISHED' },
        data: { status: 'DRAFT' },
      });
      if (changed.count === 0) {
        throw new ConflictException('The package changed. Reload and try again.');
      }
      await this.audit(tx, userId, id, 'package.unpublish', {});
    });
    return this.getOwn(userId, id);
  }

  /** Takes a package off sale for good (it stays on record). */
  async archive(userId: string, id: string): Promise<OwnPackage> {
    const row = await this.loadOwnPackage(userId, id);
    if (row.status === 'ARCHIVED') throw new ConflictException('This package is already archived');
    if (row.status === 'SUSPENDED') {
      throw new ConflictException('Voyago suspended this package. Contact support.');
    }
    await this.assertNoBookings(
      id,
      'People have booked this package. Cancel their bookings first.',
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.commercialPackage.update({ where: { id }, data: { status: 'ARCHIVED' } });
      await this.audit(tx, userId, id, 'package.archive', { from: row.status });
    });
    return this.getOwn(userId, id);
  }

  // ── Everyone: browsing ────────────────────────────────────────────────────

  async list(query: z.output<typeof PackagesQuerySchema>) {
    const cursor = decodeCursor(query.cursor);
    const q = query.q?.trim();
    const and: Prisma.CommercialPackageWhereInput[] = [LISTED(new Date())];
    if (q) {
      and.push({
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { destinationName: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    if (query.operator) and.push({ operator: { slug: query.operator } });
    if (cursor) {
      and.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      });
    }
    const rows = await this.prisma.commercialPackage.findMany({
      where: {
        AND: and,
        ...(query.mode ? { mode: query.mode } : {}),
        ...(query.activityType ? { activityType: query.activityType } : {}),
      },
      select: packageSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: await this.cards(page.data), page: page.page };
  }

  /**
   * A listing's full terms. Others see published listings of verified businesses (past ones too,
   * marked closed); the operator sees all of their own, and moderators see any.
   */
  async get(user: AuthUser, id: string): Promise<PackageDetail> {
    const row = await this.prisma.commercialPackage.findUnique({
      where: { id },
      select: packageSelect,
    });
    const isOperator = row?.operator.ownerUserId === user.id;
    const isStaff = hasPermission(user.role, 'content.moderate');
    const visible =
      row &&
      (isOperator ||
        isStaff ||
        (row.status === 'PUBLISHED' && row.operator.verificationStatus === 'VERIFIED'));
    if (!row || !visible) throw new NotFoundException('Package not found');
    if (!isOperator && !isStaff) await this.countView(id, user.id);
    const [points, held, hidden, booking] = await Promise.all([
      this.points([id]),
      this.heldSeats([id]),
      blockedIds(this.prisma, user.id),
      this.prisma.booking.findFirst({
        where: { packageId: id, userId: user.id, status: HOLDING },
        select: { id: true, status: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const view = this.detail(row, points.get(id), held.get(id) ?? 0, {
      isOperator,
      canAsk:
        !isOperator && row.status === 'PUBLISHED' && !hidden.includes(row.operator.ownerUserId),
      bookingId: booking?.id ?? null,
    });
    if (isOperator) view.bookingOpen = false;
    if (isOperator && !view.bookingClosedReason) view.bookingClosedReason = 'This is your package';
    // Confirmed guests get the exact meeting point.
    const exact = points.get(id)?.meetingPoint;
    if (booking?.status === 'CONFIRMED' && exact) {
      view.meetingPoint = { ...view.meetingPoint, point: exact, approximate: false };
    }
    return view;
  }

  async operatorProfile(user: AuthUser, slug: string): Promise<PublicOperator> {
    const operator = await this.prisma.commercialOperator.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        displayName: true,
        category: true,
        description: true,
        city: true,
        state: true,
        website: true,
        verificationStatus: true,
        verifiedAt: true,
        ownerUserId: true,
      },
    });
    const visible =
      operator && (operator.verificationStatus === 'VERIFIED' || operator.ownerUserId === user.id);
    if (!operator || !visible) throw new NotFoundException('Business not found');
    const rows = await this.prisma.commercialPackage.findMany({
      where: { operatorId: operator.id, ...LISTED(new Date()) },
      select: packageSelect,
      orderBy: { startsAt: 'asc' },
      take: 50,
    });
    return {
      slug: operator.slug,
      displayName: operator.displayName,
      category: operator.category,
      description: operator.description,
      city: operator.city,
      state: operator.state,
      website: operator.website,
      verified: operator.verificationStatus === 'VERIFIED',
      verifiedSince: operator.verifiedAt?.toISOString() ?? null,
      packages: await this.cards(rows),
    };
  }

  // ── Questions ─────────────────────────────────────────────────────────────

  /** Answered questions for everyone, plus the viewer's own; the operator sees all of them. */
  async questions(user: AuthUser, packageId: string): Promise<PackageQuestion[]> {
    const pkg = await this.get(user, packageId);
    const rows = await this.prisma.packageQuestion.findMany({
      where: {
        packageId,
        ...(pkg.viewer.isOperator
          ? {}
          : { hiddenAt: null, OR: [{ answeredAt: { not: null } }, { askerId: user.id }] }),
      },
      include: { asker: { select: { id: true, username: true, displayName: true } } },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
    return rows.map((row) => this.toQuestion(row, user.id, pkg.viewer.isOperator));
  }

  async ask(user: AuthUser, packageId: string, question: string): Promise<PackageQuestion> {
    const pkg = await this.get(user, packageId);
    if (!pkg.viewer.canAsk) {
      throw new ForbiddenException('You cannot ask a question about this package');
    }
    const since = new Date(Date.now() - DAY_MS);
    const [onPackage, total] = await Promise.all([
      this.prisma.packageQuestion.count({
        where: { askerId: user.id, packageId, createdAt: { gte: since } },
      }),
      this.prisma.packageQuestion.count({ where: { askerId: user.id, createdAt: { gte: since } } }),
    ]);
    if (onPackage >= QUESTIONS_PER_PACKAGE_PER_DAY || total >= QUESTIONS_PER_DAY) {
      throw new HttpException(
        'You have asked a lot of questions today. Try again tomorrow.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const owner = await this.prisma.commercialPackage.findUniqueOrThrow({
      where: { id: packageId },
      select: { title: true, operator: { select: { ownerUserId: true } } },
    });
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.packageQuestion.create({
        data: { packageId, askerId: user.id, question },
        include: { asker: { select: { id: true, username: true, displayName: true } } },
      });
      await this.notifications.notify(tx, [owner.operator.ownerUserId], {
        type: 'SYSTEM',
        title: `New question about ${owner.title}`,
        body: question.length > 120 ? `${question.slice(0, 117)}…` : question,
        data: { packageId, screen: 'questions' },
      });
      return created;
    });
    return this.toQuestion(row, user.id, false);
  }

  /** The operator's questions across their packages, newest first. */
  async operatorQuestions(userId: string, query: z.output<typeof OperatorQuestionsQuerySchema>) {
    const operator = await this.operators.loadOwn(userId);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.packageQuestion.findMany({
      where: {
        package: { operatorId: operator.id },
        ...(query.unanswered === 'true' ? { answeredAt: null, hiddenAt: null } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: { asker: { select: { id: true, username: true, displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map((row) => this.toQuestion(row, userId, true)), page: page.page };
  }

  async answer(userId: string, questionId: string, answer: string): Promise<PackageQuestion> {
    const question = await this.loadOwnQuestion(userId, questionId);
    if (question.hiddenAt) throw new ConflictException('This question is hidden');
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.packageQuestion.update({
        where: { id: questionId },
        data: { answer, answeredAt: new Date(), answeredById: userId },
        include: { asker: { select: { id: true, username: true, displayName: true } } },
      });
      if (!question.answeredAt) {
        await this.notifications.notify(tx, [question.askerId], {
          type: 'SYSTEM',
          title: `Your question about ${question.package.title} was answered`,
          body: answer.length > 120 ? `${answer.slice(0, 117)}…` : answer,
          data: { packageId: question.packageId },
        });
      }
      return row;
    });
    return this.toQuestion(updated, userId, true);
  }

  /** Spam or abuse: hidden from everyone but the operator and staff. */
  async hideQuestion(userId: string, questionId: string): Promise<PackageQuestion> {
    await this.loadOwnQuestion(userId, questionId);
    const row = await this.prisma.packageQuestion.update({
      where: { id: questionId },
      data: { hiddenAt: new Date() },
      include: { asker: { select: { id: true, username: true, displayName: true } } },
    });
    return this.toQuestion(row, userId, true);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async loadOwnPackage(userId: string, id: string): Promise<PackageRow> {
    const row = await this.prisma.commercialPackage.findUnique({
      where: { id },
      select: packageSelect,
    });
    if (!row || row.operator.ownerUserId !== userId)
      throw new NotFoundException('Package not found');
    return row;
  }

  private async loadOwnQuestion(userId: string, id: string) {
    const question = await this.prisma.packageQuestion.findUnique({
      where: { id },
      select: {
        id: true,
        packageId: true,
        askerId: true,
        answeredAt: true,
        hiddenAt: true,
        package: { select: { title: true, operator: { select: { ownerUserId: true } } } },
      },
    });
    if (!question || question.package.operator.ownerUserId !== userId) {
      throw new NotFoundException('Question not found');
    }
    return question;
  }

  /** Photos must be the operator's own uploads; ones already on the package are trusted. */
  private async assertPhotos(userId: string, photoIds: string[], existing: string[]) {
    if (new Set(photoIds).size !== photoIds.length) {
      throw new HttpException(
        {
          message: 'Validation failed',
          details: [{ path: 'photoIds', message: 'Each photo once' }],
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    for (const photoId of photoIds.filter((p) => !existing.includes(p))) {
      await this.cloudinary.assertOwnUpload(userId, photoId, 'package-photo', 'photoIds');
    }
  }

  private async assertNoBookings(id: string, message: string) {
    const held = await this.prisma.booking.count({ where: { packageId: id, status: HOLDING } });
    if (held > 0) throw new ConflictException(message);
  }

  private publishIssues(row: PackageRow, now = Date.now()): string[] {
    const issues: string[] = [];
    if (!row.startsAt || !row.endsAt) issues.push('Set the start and end dates');
    else if (row.startsAt.getTime() <= now) issues.push('Choose a start date in the future');
    if (!row.meetingPointName) issues.push('Set the meeting point');
    if (row.inclusions.length === 0) issues.push('List what is included');
    if (row.cancellationPolicy.trim().length < 20) issues.push('Write the cancellation terms');
    if (tiersOf(row).length === 0) issues.push('Set the refund schedule');
    return issues;
  }

  private async countView(id: string, userId: string): Promise<void> {
    try {
      if (!this.redis.isReady) return;
      const first = await this.redis.client.set(`pkgview:${id}:${userId}`, '1', 'EX', 86_400, 'NX');
      if (first !== 'OK') return;
      await this.prisma.commercialPackage.update({
        where: { id },
        data: { viewCount: { increment: 1 } },
      });
    } catch (error) {
      this.logger.warn(`Could not count a package view: ${(error as Error).message}`);
    }
  }

  private async points(ids: string[]): Promise<Map<string, Points>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        dlat: number | null;
        dlng: number | null;
        mlat: number | null;
        mlng: number | null;
      }[]
    >(Prisma.sql`
      SELECT "id",
        ST_Y("destination"::geometry) AS dlat, ST_X("destination"::geometry) AS dlng,
        ST_Y("meeting_point"::geometry) AS mlat, ST_X("meeting_point"::geometry) AS mlng
      FROM "commercial_packages" WHERE "id" = ANY(${ids}::uuid[])`);
    return new Map(
      rows.map((r) => [
        r.id,
        {
          destination:
            r.dlat !== null && r.dlng !== null ? { latitude: r.dlat, longitude: r.dlng } : null,
          meetingPoint:
            r.mlat !== null && r.mlng !== null ? { latitude: r.mlat, longitude: r.mlng } : null,
        },
      ]),
    );
  }

  private async heldSeats(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const groups = await this.prisma.booking.groupBy({
      by: ['packageId'],
      where: { packageId: { in: ids }, status: HOLDING },
      _sum: { seats: true },
    });
    return new Map(groups.map((g) => [g.packageId, g._sum.seats ?? 0]));
  }

  private card(row: PackageRow, held: number): PackageCard {
    return {
      id: row.id,
      commercial: true,
      title: row.title,
      mode: row.mode,
      activityType: row.activityType,
      destinationName: row.destinationName,
      startsAt: row.startsAt?.toISOString() ?? '',
      endsAt: row.endsAt?.toISOString() ?? '',
      durationDays: row.durationDays,
      pricePaise: row.pricePaise,
      currency: row.currency,
      capacity: row.maxGroupSize,
      seatsLeft: Math.max(0, row.maxGroupSize - held),
      coverImageUrl: this.cloudinary.coverUrl(row.coverImageKey),
      operator: {
        slug: row.operator.slug,
        displayName: row.operator.displayName,
        category: row.operator.category,
        verified: row.operator.verificationStatus === 'VERIFIED',
      },
    };
  }

  private async cards(rows: PackageRow[]): Promise<PackageCard[]> {
    const held = await this.heldSeats(rows.map((r) => r.id));
    return rows.map((row) => this.card(row, held.get(row.id) ?? 0));
  }

  private detail(
    row: PackageRow,
    points: Points | undefined,
    held: number,
    viewer: PackageDetail['viewer'],
  ): PackageDetail {
    const meeting = points?.meetingPoint ?? null;
    return {
      ...this.card(row, held),
      status: row.status,
      description: row.description,
      destination: { name: row.destinationName, point: points?.destination ?? null },
      meetingPoint: {
        name: row.meetingPointName ?? '',
        point: meeting ? (viewer.isOperator ? meeting : approximate(meeting)) : null,
        approximate: !viewer.isOperator,
      },
      inclusions: row.inclusions,
      exclusions: row.exclusions,
      cancellationPolicy: row.cancellationPolicy,
      refundTiers: tiersOf(row),
      imageUrls: row.imageKeys
        .map((key) => this.cloudinary.photoUrl(key))
        .filter((url): url is string => url !== null),
      ...this.bookingState(row, held),
      viewer,
    };
  }

  /** Whether a customer can book now, and if not, why. */
  private bookingState(row: PackageRow, held: number, now = Date.now()) {
    const reason = !this.gateway.enabled
      ? 'Online booking is not available yet'
      : row.status !== 'PUBLISHED' || row.operator.verificationStatus !== 'VERIFIED'
        ? 'This experience is not on sale'
        : !row.startsAt || row.startsAt.getTime() <= now
          ? 'This experience has started'
          : tiersOf(row).length === 0
            ? 'This experience has no refund schedule yet'
            : row.maxGroupSize - held <= 0
              ? 'Fully booked'
              : null;
    return { bookingOpen: reason === null, bookingClosedReason: reason };
  }

  private async ownViews(rows: PackageRow[]): Promise<OwnPackage[]> {
    const ids = rows.map((r) => r.id);
    const [points, held, questions] = await Promise.all([
      this.points(ids),
      this.heldSeats(ids),
      this.prisma.packageQuestion.groupBy({
        by: ['packageId', 'answeredAt'],
        where: { packageId: { in: ids }, hiddenAt: null },
        _count: { _all: true },
      }),
    ]);
    return rows.map((row) => {
      const mine = questions.filter((q) => q.packageId === row.id);
      const issues = this.publishIssues(row);
      const actions: OwnPackage['actions'] = [];
      if (row.status === 'DRAFT') actions.push('edit');
      if (row.status === 'DRAFT' && row.operator.verificationStatus === 'VERIFIED') {
        actions.push('publish');
      }
      if (row.status === 'PUBLISHED') actions.push('unpublish');
      if (row.status === 'DRAFT' || row.status === 'PUBLISHED') actions.push('archive');
      return {
        ...this.detail(row, points.get(row.id), held.get(row.id) ?? 0, {
          isOperator: true,
          canAsk: false,
          bookingId: null,
        }),
        photoIds: row.imageKeys,
        suspendedReason: row.suspendedReason,
        viewCount: row.viewCount,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        questions: {
          total: mine.reduce((sum, q) => sum + q._count._all, 0),
          unanswered: mine
            .filter((q) => q.answeredAt === null)
            .reduce((sum, q) => sum + q._count._all, 0),
        },
        publishIssues:
          row.operator.verificationStatus === 'VERIFIED'
            ? issues
            : ['Your business must be verified first', ...issues],
        actions,
      };
    });
  }

  private toQuestion(
    row: {
      id: string;
      packageId: string;
      askerId: string;
      question: string;
      answer: string | null;
      answeredAt: Date | null;
      hiddenAt: Date | null;
      createdAt: Date;
      asker: { username: string; displayName: string };
    },
    viewerId: string,
    isOperator: boolean,
  ): PackageQuestion {
    const mine = row.askerId === viewerId;
    return {
      id: row.id,
      packageId: row.packageId,
      question: row.question,
      answer: row.answer,
      answeredAt: row.answeredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      asker:
        isOperator || mine
          ? { username: row.asker.username, displayName: row.asker.displayName }
          : null,
      mine,
      hidden: row.hiddenAt !== null,
    };
  }

  private audit(
    tx: Prisma.TransactionClient,
    userId: string,
    packageId: string,
    action: string,
    metadata: Prisma.InputJsonObject,
  ) {
    return tx.auditLog.create({
      data: {
        actorId: userId,
        actorType: 'USER',
        action,
        entityType: 'package',
        entityId: packageId,
        metadata,
      },
    });
  }
}
