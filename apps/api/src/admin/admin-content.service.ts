import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AdminTripDetail,
  type AdminTripsQuerySchema,
  type AdminTripSummary,
  canTransition,
  hasPermission,
} from '@voyago/shared';
import { type z } from 'zod';
import { RealtimeService } from '../chat/realtime.service.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';
import { TripsService } from '../trips/trips.service.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { AdminReportsService } from './admin-reports.service.js';
import { recordAudit } from './audit.js';
import { staffPerson, staffPersonSelect } from './people.js';
import { type Actor } from './permissions.js';

const tripSelect = {
  id: true,
  title: true,
  mode: true,
  status: true,
  visibility: true,
  tripType: true,
  originName: true,
  destinationName: true,
  departureAt: true,
  hiddenAt: true,
  createdAt: true,
  organiser: { select: staffPersonSelect },
} as const satisfies Prisma.TripSelect;

type TripRow = Prisma.TripGetPayload<{ select: typeof tripSelect }>;

/**
 * Trip, post and chat-message moderation. Hiding keeps a trip for its organiser and the people
 * on it but removes it from discovery, feeds and community lists; cancelling goes through the
 * normal cancellation (participants are told the reason). Every action needs a reason and is
 * audited. Exact meeting points are never shown here.
 */
@Injectable()
export class AdminContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly overview: AdminOverviewService,
    private readonly reports: AdminReportsService,
    private readonly trips: TripsService,
    private readonly realtime: RealtimeService,
  ) {}

  async listTrips(query: z.output<typeof AdminTripsQuerySchema>) {
    const cursor = decodeCursor(query.cursor);
    const q = query.q?.trim();
    const and: Prisma.TripWhereInput[] = [];
    if (q) {
      and.push({
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { originName: { contains: q, mode: 'insensitive' } },
          { destinationName: { contains: q, mode: 'insensitive' } },
          ...(/^[0-9a-f-]{36}$/i.test(q) ? [{ id: q.toLowerCase() }] : []),
        ],
      });
    }
    if (query.reported === 'true') {
      const reported = await this.prisma.report.findMany({
        where: { targetType: 'TRIP', status: { in: ['OPEN', 'IN_REVIEW'] } },
        select: { targetId: true },
        distinct: ['targetId'],
        take: 1000,
      });
      and.push({ id: { in: reported.map((r) => r.targetId) } });
    }
    if (cursor) {
      and.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      });
    }
    const rows = await this.prisma.trip.findMany({
      where: {
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.hidden === 'true'
          ? { hiddenAt: { not: null } }
          : query.hidden === 'false'
            ? { hiddenAt: null }
            : {}),
        AND: and,
      },
      select: tripSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: await this.tripSummaries(page.data), page: page.page };
  }

  async getTrip(actor: Actor, id: string): Promise<AdminTripDetail> {
    const row = await this.prisma.trip.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...tripSelect,
        description: true,
        maxParticipants: true,
        hiddenReason: true,
        cancellationReason: true,
      },
    });
    if (!row) throw new NotFoundException('Trip not found');
    const [[summary], participantCount, reports, history] = await Promise.all([
      this.tripSummaries([row]),
      this.prisma.tripParticipant.count({ where: { tripId: id, status: 'ACTIVE' } }),
      this.reports.summariesWhere({ targetType: 'TRIP', targetId: id }, 25),
      this.overview.historyOf('trip', id),
    ]);
    const actions: AdminTripDetail['actions'] = [];
    if (hasPermission(actor.user.role, 'content.moderate')) {
      actions.push(row.hiddenAt ? 'unhide' : 'hide');
      if (row.tripType === 'COMMUNITY_FREE' && canTransition(row.status, 'CANCELLED')) {
        actions.push('cancel');
      }
    }
    return {
      ...summary!,
      description: row.description,
      maxParticipants: row.maxParticipants,
      participantCount,
      hiddenReason: row.hiddenReason,
      cancellationReason: row.cancellationReason,
      reports,
      history,
      actions,
    };
  }

  async hideTrip(actor: Actor, id: string, reason: string): Promise<AdminTripDetail> {
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.trip.updateMany({
        where: { id, deletedAt: null, hiddenAt: null },
        data: { hiddenAt: new Date(), hiddenReason: reason, hiddenById: actor.user.id },
      });
      if (changed.count === 0) await this.tripConflict(id, 'This trip is already hidden');
      await recordAudit(tx, actor, {
        action: 'trip.hide',
        entityType: 'trip',
        entityId: id,
        reason,
      });
    });
    return this.getTrip(actor, id);
  }

  async unhideTrip(actor: Actor, id: string, reason: string): Promise<AdminTripDetail> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.trip.findFirst({
        where: { id, deletedAt: null },
        select: { hiddenReason: true },
      });
      const changed = await tx.trip.updateMany({
        where: { id, deletedAt: null, hiddenAt: { not: null } },
        data: { hiddenAt: null, hiddenReason: null, hiddenById: null },
      });
      if (changed.count === 0) await this.tripConflict(id, 'This trip is not hidden');
      await recordAudit(tx, actor, {
        action: 'trip.unhide',
        entityType: 'trip',
        entityId: id,
        reason,
        metadata: { previousReason: before?.hiddenReason ?? null },
      });
    });
    return this.getTrip(actor, id);
  }

  /** The normal cancellation, as staff: participants are notified, and it is audited there. */
  async cancelTrip(actor: Actor, id: string, reason: string): Promise<AdminTripDetail> {
    const row = await this.prisma.trip.findFirst({
      where: { id, deletedAt: null },
      select: { organiserId: true, tripType: true },
    });
    if (!row) throw new NotFoundException('Trip not found');
    if (row.organiserId === actor.user.id) {
      throw new ConflictException('Cancel your own trip from the app, not as staff');
    }
    if (row.tripType !== 'COMMUNITY_FREE') {
      throw new ConflictException('Commercial departures are managed through their package');
    }
    await this.trips.cancel(actor.user, id, reason, actor.requestId ?? undefined);
    return this.getTrip(actor, id);
  }

  async removePost(actor: Actor, id: string, reason: string): Promise<void> {
    const post = await this.prisma.post.findUnique({
      where: { id },
      select: { authorId: true, communityId: true, deletedAt: true },
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.deletedAt) throw new ConflictException('This post is already removed');
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.post.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (changed.count === 0) throw new ConflictException('This post is already removed');
      await recordAudit(tx, actor, {
        action: 'post.remove',
        entityType: 'post',
        entityId: id,
        reason,
        metadata: { authorId: post.authorId, communityId: post.communityId },
      });
    });
  }

  /** Removes a chat message for everyone, as when its sender deletes it. */
  async removeMessage(actor: Actor, id: string, reason: string): Promise<void> {
    const message = await this.prisma.message.findUnique({
      where: { id },
      select: { senderId: true, conversationId: true, deletedAt: true },
    });
    if (!message) throw new NotFoundException('Message not found');
    if (message.deletedAt) throw new ConflictException('This message is already removed');
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.message.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date(), body: null, attachmentKey: null },
      });
      if (changed.count === 0) throw new ConflictException('This message is already removed');
      await recordAudit(tx, actor, {
        action: 'message.remove',
        entityType: 'message',
        entityId: id,
        reason,
        metadata: { senderId: message.senderId, conversationId: message.conversationId },
      });
    });
    this.realtime.emitToConversation(message.conversationId, [], 'message:deleted', {
      conversationId: message.conversationId,
      messageId: id,
    });
  }

  private async tripConflict(id: string, message: string): Promise<never> {
    const exists = await this.prisma.trip.count({ where: { id, deletedAt: null } });
    throw exists ? new ConflictException(message) : new NotFoundException('Trip not found');
  }

  private async tripSummaries(rows: TripRow[]): Promise<AdminTripSummary[]> {
    const open = await this.prisma.report.groupBy({
      by: ['targetId'],
      where: {
        targetType: 'TRIP',
        targetId: { in: rows.map((r) => r.id) },
        status: { in: ['OPEN', 'IN_REVIEW'] },
      },
      _count: { _all: true },
    });
    const counts = new Map(open.map((g) => [g.targetId, g._count._all]));
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      mode: row.mode,
      status: row.status,
      visibility: row.visibility,
      originName: row.originName,
      destinationName: row.destinationName,
      departureAt: row.departureAt.toISOString(),
      organiser: staffPerson(row.organiser),
      hidden: row.hiddenAt !== null,
      openReports: counts.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
