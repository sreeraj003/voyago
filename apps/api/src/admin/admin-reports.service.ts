import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type AdminReportDetail,
  type AdminReportsQuerySchema,
  type AdminReportSummary,
  canTransition,
  hasPermission,
  isStaffRole,
  type ReportTargetSnapshot,
  type ResolveReportSchema,
  type TriageReportSchema,
} from '@voyago/shared';
import { type z } from 'zod';
import { PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { recordAudit } from './audit.js';
import { decodeOffsetCursor, offsetPage } from '../discovery/discovery-query.js';
import { staffPerson, staffPersonSelect } from './people.js';
import { type Actor } from './permissions.js';

const reportSelect = {
  id: true,
  targetType: true,
  targetId: true,
  reason: true,
  severity: true,
  status: true,
  details: true,
  evidenceRefs: true,
  resolutionNote: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  reporterId: true,
  reporter: { select: staffPersonSelect },
  reportedUser: { select: { ...staffPersonSelect, status: true, deletedAt: true } },
  assignedTo: { select: staffPersonSelect },
} as const satisfies Prisma.ReportSelect;

type ReportRow = Prisma.ReportGetPayload<{ select: typeof reportSelect }>;

const UNRESOLVED = ['OPEN', 'IN_REVIEW'] as const;

/**
 * The report queue and its lifecycle: OPEN, then IN_REVIEW once someone picks it up or triages
 * it, then ACTIONED or DISMISSED with a resolution note. A resolved report can be reopened with a
 * reason. Every change is audited. Reporters get a generic "we reviewed your report" update that
 * never reveals what happened to the other person.
 */
@Injectable()
export class AdminReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly overview: AdminOverviewService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(actor: Actor, query: z.output<typeof AdminReportsQuerySchema>) {
    const offset = decodeOffsetCursor(query.cursor);
    const where: Prisma.ReportWhereInput = {
      ...(query.status === 'QUEUE'
        ? { status: { in: [...UNRESOLVED] } }
        : query.status === 'ALL'
          ? {}
          : { status: query.status }),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.assigned === 'me'
        ? { assignedToId: actor.user.id }
        : query.assigned === 'unassigned'
          ? { assignedToId: null }
          : {}),
    };
    // The open queue is worked most severe first, then oldest first; history newest first.
    const orderBy: Prisma.ReportOrderByWithRelationInput[] =
      query.status === 'QUEUE' || query.status === 'OPEN' || query.status === 'IN_REVIEW'
        ? [{ severity: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }]
        : [{ updatedAt: 'desc' }, { id: 'desc' }];
    const rows = await this.prisma.report.findMany({
      where,
      select: reportSelect,
      orderBy,
      skip: offset,
      take: query.limit + 1,
    });
    const page = offsetPage(rows, offset, query.limit);
    return { data: await this.toSummaries(page.data), page: page.page };
  }

  async summariesWhere(where: Prisma.ReportWhereInput, take: number) {
    const rows = await this.prisma.report.findMany({
      where,
      select: reportSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return this.toSummaries(rows);
  }

  async get(actor: Actor, id: string): Promise<AdminReportDetail> {
    const row = await this.load(id);
    const [summary] = await this.toSummaries([row]);
    const [target, related, history] = await Promise.all([
      this.snapshot(row.targetType, row.targetId),
      this.summariesWhere(
        { targetType: row.targetType, targetId: row.targetId, id: { not: row.id } },
        20,
      ),
      this.overview.historyOf('report', id),
    ]);
    return {
      ...summary!,
      details: row.details,
      evidenceRefs: row.evidenceRefs,
      resolutionNote: row.resolutionNote,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      target,
      related,
      history,
      actions: await this.actionsFor(actor, row, target),
    };
  }

  async assign(actor: Actor, id: string, assigneeId: string | null): Promise<AdminReportDetail> {
    const row = await this.load(id);
    this.assertUnresolved(row);
    if (assigneeId) {
      const assignee = await this.prisma.user.findFirst({
        where: { id: assigneeId, status: 'ACTIVE', deletedAt: null },
        select: { role: true },
      });
      if (!assignee || !hasPermission(assignee.role, 'reports.manage')) {
        throw new BadRequestException({
          message: 'Validation failed',
          details: [{ path: 'assigneeId', message: 'Choose a moderator or super admin' }],
        });
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await this.updateUnresolved(tx, row, {
        assignedToId: assigneeId,
        ...(assigneeId && row.status === 'OPEN' ? { status: 'IN_REVIEW' } : {}),
      });
      await recordAudit(tx, actor, {
        action: 'report.assign',
        entityType: 'report',
        entityId: id,
        metadata: { from: row.assignedTo?.id ?? null, to: assigneeId },
      });
    });
    return this.get(actor, id);
  }

  async triage(
    actor: Actor,
    id: string,
    input: z.output<typeof TriageReportSchema>,
  ): Promise<AdminReportDetail> {
    const row = await this.load(id);
    this.assertUnresolved(row);
    const evidenceRefs = input.evidenceRefs ? [...new Set(input.evidenceRefs)] : undefined;
    await this.prisma.$transaction(async (tx) => {
      await this.updateUnresolved(tx, row, {
        ...(input.severity ? { severity: input.severity } : {}),
        ...(evidenceRefs ? { evidenceRefs } : {}),
        ...(row.status === 'OPEN' ? { status: 'IN_REVIEW' } : {}),
      });
      await recordAudit(tx, actor, {
        action: 'report.triage',
        entityType: 'report',
        entityId: id,
        metadata: {
          ...(input.severity ? { severity: { from: row.severity, to: input.severity } } : {}),
          ...(evidenceRefs ? { evidenceRefs: { from: row.evidenceRefs, to: evidenceRefs } } : {}),
        },
      });
    });
    return this.get(actor, id);
  }

  async resolve(
    actor: Actor,
    id: string,
    input: z.output<typeof ResolveReportSchema>,
  ): Promise<AdminReportDetail> {
    const row = await this.load(id);
    this.assertUnresolved(row);
    await this.prisma.$transaction(async (tx) => {
      await this.updateUnresolved(tx, row, {
        status: input.outcome,
        resolutionNote: input.note,
        resolvedAt: new Date(),
        assignedToId: row.assignedTo?.id ?? actor.user.id,
      });
      await recordAudit(tx, actor, {
        action: 'report.resolve',
        entityType: 'report',
        entityId: id,
        reason: input.note,
        metadata: { outcome: input.outcome, previousStatus: row.status },
      });
      if (row.reporterId) {
        await this.notifications.notify(tx, [row.reporterId], {
          type: 'SYSTEM',
          title: 'We reviewed your report',
          body:
            input.outcome === 'ACTIONED'
              ? 'Thanks for telling us. We took action under our community guidelines.'
              : 'Thanks for telling us. We did not find a guideline violation this time.',
          data: {},
        });
      }
    });
    return this.get(actor, id);
  }

  async reopen(actor: Actor, id: string, reason: string): Promise<AdminReportDetail> {
    const row = await this.load(id);
    if (row.status !== 'ACTIONED' && row.status !== 'DISMISSED') {
      throw new ConflictException('Only resolved reports can be reopened');
    }
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.report.updateMany({
        where: { id, status: row.status },
        data: { status: 'IN_REVIEW', resolvedAt: null, resolutionNote: null },
      });
      if (changed.count === 0) throw changedConflict();
      await recordAudit(tx, actor, {
        action: 'report.reopen',
        entityType: 'report',
        entityId: id,
        reason,
        metadata: { previousStatus: row.status, previousNote: row.resolutionNote },
      });
    });
    return this.get(actor, id);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async load(id: string): Promise<ReportRow> {
    const row = await this.prisma.report.findUnique({ where: { id }, select: reportSelect });
    if (!row) throw new NotFoundException('Report not found');
    return row;
  }

  private assertUnresolved(row: ReportRow): void {
    if (row.status !== 'OPEN' && row.status !== 'IN_REVIEW') {
      throw new ConflictException('This report is resolved. Reopen it first.');
    }
  }

  /** Applies a change only if nobody resolved or changed the status in the meantime. */
  private async updateUnresolved(
    tx: Prisma.TransactionClient,
    row: ReportRow,
    data: Prisma.ReportUncheckedUpdateManyInput,
  ): Promise<void> {
    const changed = await tx.report.updateMany({
      where: { id: row.id, status: row.status },
      data,
    });
    if (changed.count === 0) throw changedConflict();
  }

  async toSummaries(rows: ReportRow[]): Promise<AdminReportSummary[]> {
    const labels = await this.labels(rows);
    return rows.map((row) => ({
      id: row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      targetLabel: labels.get(row.targetId) ?? `${row.targetType.toLowerCase()} (not found)`,
      reason: row.reason,
      severity: row.severity,
      status: row.status,
      reporter: row.reporter ? staffPerson(row.reporter) : null,
      reportedUser: row.reportedUser ? staffPerson(row.reportedUser) : null,
      assignedTo: row.assignedTo ? staffPerson(row.assignedTo) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** Short labels for reported things, fetched in one query per kind. */
  private async labels(rows: Pick<ReportRow, 'targetType' | 'targetId'>[]) {
    const ids = (type: string) => rows.filter((r) => r.targetType === type).map((r) => r.targetId);
    const [users, trips, communities, posts, messages, packages] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: ids('USER') } },
        select: { id: true, username: true },
      }),
      this.prisma.trip.findMany({
        where: { id: { in: ids('TRIP') } },
        select: { id: true, title: true },
      }),
      this.prisma.community.findMany({
        where: { id: { in: ids('COMMUNITY') } },
        select: { id: true, name: true },
      }),
      this.prisma.post.findMany({
        where: { id: { in: ids('POST') } },
        select: { id: true, author: { select: { username: true } } },
      }),
      this.prisma.message.findMany({
        where: { id: { in: ids('MESSAGE') } },
        select: { id: true, sender: { select: { username: true } } },
      }),
      this.prisma.commercialPackage.findMany({
        where: { id: { in: ids('COMMERCIAL_PACKAGE') } },
        select: { id: true, title: true },
      }),
    ]);
    return new Map<string, string>([
      ...users.map((u) => [u.id, `@${u.username}`] as const),
      ...trips.map((t) => [t.id, t.title] as const),
      ...communities.map((c) => [c.id, c.name] as const),
      ...posts.map((p) => [p.id, `Post by @${p.author.username}`] as const),
      ...messages.map(
        (m) => [m.id, m.sender ? `Message from @${m.sender.username}` : 'Chat message'] as const,
      ),
      ...packages.map((p) => [p.id, `Package: ${p.title}`] as const),
    ]);
  }

  /** The reported thing as it is now. Chat messages show only the reported message itself. */
  async snapshot(type: string, id: string): Promise<ReportTargetSnapshot> {
    const missing: ReportTargetSnapshot = {
      exists: false,
      text: null,
      status: null,
      removed: false,
      context: null,
    };
    switch (type) {
      case 'USER': {
        const user = await this.prisma.user.findUnique({
          where: { id },
          select: { username: true, bio: true, status: true, deletedAt: true },
        });
        if (!user) return missing;
        return {
          exists: true,
          text: user.bio,
          status: user.status,
          removed: user.deletedAt !== null,
          context: `@${user.username}`,
        };
      }
      case 'TRIP': {
        const trip = await this.prisma.trip.findUnique({
          where: { id },
          select: {
            description: true,
            status: true,
            hiddenAt: true,
            deletedAt: true,
            originName: true,
            destinationName: true,
          },
        });
        if (!trip) return missing;
        return {
          exists: true,
          text: trip.description,
          status: trip.hiddenAt ? `${trip.status} (hidden)` : trip.status,
          removed: trip.deletedAt !== null,
          context: `From ${trip.originName} to ${trip.destinationName}`,
        };
      }
      case 'COMMERCIAL_PACKAGE': {
        const pkg = await this.prisma.commercialPackage.findUnique({
          where: { id },
          select: {
            description: true,
            status: true,
            pricePaise: true,
            operator: { select: { displayName: true } },
          },
        });
        if (!pkg) return missing;
        return {
          exists: true,
          text: pkg.description,
          status: pkg.status,
          removed: pkg.status === 'ARCHIVED',
          context: `Sold by ${pkg.operator.displayName}, ₹${pkg.pricePaise / 100} per person`,
        };
      }
      case 'COMMUNITY': {
        const community = await this.prisma.community.findUnique({
          where: { id },
          select: { name: true, description: true, deletedAt: true },
        });
        if (!community) return missing;
        return {
          exists: true,
          text: community.description,
          status: null,
          removed: community.deletedAt !== null,
          context: community.name,
        };
      }
      case 'POST': {
        const post = await this.prisma.post.findUnique({
          where: { id },
          select: {
            body: true,
            imageKeys: true,
            deletedAt: true,
            community: { select: { name: true } },
          },
        });
        if (!post) return missing;
        const photos = post.imageKeys.length > 0 ? ` (${post.imageKeys.length} photo(s))` : '';
        return {
          exists: true,
          text: post.body,
          status: null,
          removed: post.deletedAt !== null,
          context: (post.community ? `Community: ${post.community.name}` : 'Profile post') + photos,
        };
      }
      case 'MESSAGE': {
        const message = await this.prisma.message.findUnique({
          where: { id },
          select: {
            body: true,
            attachmentKey: true,
            deletedAt: true,
            conversation: {
              select: {
                type: true,
                trip: { select: { title: true } },
                community: { select: { name: true } },
              },
            },
          },
        });
        if (!message) return missing;
        const c = message.conversation;
        return {
          exists: true,
          text: message.body ?? (message.attachmentKey ? '(photo)' : null),
          status: null,
          removed: message.deletedAt !== null,
          context:
            c.type === 'TRIP_GROUP'
              ? `Trip chat: ${c.trip?.title ?? 'trip'}`
              : c.type === 'COMMUNITY'
                ? `Community chat: ${c.community?.name ?? 'community'}`
                : 'Direct message',
        };
      }
      default:
        return missing;
    }
  }

  private async actionsFor(
    actor: Actor,
    row: ReportRow,
    target: ReportTargetSnapshot,
  ): Promise<AdminReportDetail['actions']> {
    const role = actor.user.role;
    const actions: AdminReportDetail['actions'] = [];
    const unresolved = row.status === 'OPEN' || row.status === 'IN_REVIEW';
    if (hasPermission(role, 'reports.manage')) {
      if (unresolved) actions.push('assign', 'triage', 'resolve');
      else actions.push('reopen');
    }
    const reported = row.reportedUser;
    if (
      hasPermission(role, 'users.suspend') &&
      reported &&
      reported.id !== actor.user.id &&
      reported.status === 'ACTIVE' &&
      !reported.deletedAt &&
      (!isStaffRole(reported.role) || role === 'SUPER_ADMIN')
    ) {
      actions.push('suspend_user');
    }
    if (hasPermission(role, 'content.moderate') && target.exists && !target.removed) {
      if (row.targetType === 'TRIP') {
        const trip = await this.prisma.trip.findUnique({
          where: { id: row.targetId },
          select: { status: true, hiddenAt: true, tripType: true },
        });
        if (trip && !trip.hiddenAt) actions.push('hide_trip');
        if (trip?.tripType === 'COMMUNITY_FREE' && canTransition(trip.status, 'CANCELLED')) {
          actions.push('cancel_trip');
        }
      }
      if (row.targetType === 'POST') actions.push('remove_post');
      if (row.targetType === 'MESSAGE') actions.push('remove_message');
    }
    return actions;
  }
}

const changedConflict = () => new ConflictException('The report changed. Reload and try again.');
