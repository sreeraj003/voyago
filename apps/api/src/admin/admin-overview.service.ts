import { Injectable, NotFoundException } from '@nestjs/common';
import {
  type AdminMe,
  type AuditEntry,
  type AuditQuerySchema,
  type Dashboard,
  isStaffRole,
  PERMISSIONS_BY_ROLE,
  type StaffPerson,
} from '@voyago/shared';
import { type z } from 'zod';
import { type AuthUser } from '../common/auth/current-user.decorator.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';
import { auditSelect, toAuditEntry } from './audit.js';
import { staffPerson, staffPersonSelect } from './people.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The signed-in staff member, dashboard metrics, the staff list and the audit log. */
@Injectable()
export class AdminOverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async me(user: AuthUser): Promise<AdminMe> {
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: staffPersonSelect,
    });
    if (!isStaffRole(row.role)) throw new NotFoundException();
    return { ...staffPerson(row), role: row.role, permissions: [...PERMISSIONS_BY_ROLE[row.role]] };
  }

  async dashboard(now = new Date()): Promise<Dashboard> {
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const live = { deletedAt: null } as const;
    const [
      total,
      registered7,
      registered30,
      active7,
      active30,
      suspended,
      created30,
      completed30,
      upcoming,
      hidden,
      open,
      inReview,
      urgent,
      pendingOperators,
      daily,
    ] = await Promise.all([
      this.prisma.user.count({ where: live }),
      this.prisma.user.count({ where: { ...live, createdAt: { gte: ago(7) } } }),
      this.prisma.user.count({ where: { ...live, createdAt: { gte: ago(30) } } }),
      this.prisma.user.count({ where: { ...live, lastActiveAt: { gte: ago(7) } } }),
      this.prisma.user.count({ where: { ...live, lastActiveAt: { gte: ago(30) } } }),
      this.prisma.user.count({ where: { ...live, status: 'SUSPENDED' } }),
      this.prisma.trip.count({ where: { ...live, createdAt: { gte: ago(30) } } }),
      this.prisma.trip.count({ where: { ...live, completedAt: { gte: ago(30) } } }),
      this.prisma.trip.count({
        where: { ...live, status: { in: ['PUBLISHED', 'FULL'] }, departureAt: { gt: now } },
      }),
      this.prisma.trip.count({ where: { ...live, hiddenAt: { not: null } } }),
      this.prisma.report.count({ where: { status: 'OPEN' } }),
      this.prisma.report.count({ where: { status: 'IN_REVIEW' } }),
      this.prisma.report.count({
        where: { status: { in: ['OPEN', 'IN_REVIEW'] }, severity: { in: ['HIGH', 'CRITICAL'] } },
      }),
      this.prisma.commercialOperator.count({ where: { verificationStatus: 'PENDING' } }),
      this.prisma.$queryRaw<{ day: string; registrations: number; trips: number }[]>`
        WITH days AS (
          SELECT generate_series(
            date_trunc('day', ${now}::timestamptz AT TIME ZONE 'UTC') - interval '13 days',
            date_trunc('day', ${now}::timestamptz AT TIME ZONE 'UTC'),
            interval '1 day'
          ) AS day
        )
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
          (SELECT count(*)::int FROM "users" u
            WHERE u.deleted_at IS NULL
              AND (u.created_at AT TIME ZONE 'UTC') >= d.day
              AND (u.created_at AT TIME ZONE 'UTC') < d.day + interval '1 day') AS registrations,
          (SELECT count(*)::int FROM "trips" t
            WHERE t.deleted_at IS NULL
              AND (t.created_at AT TIME ZONE 'UTC') >= d.day
              AND (t.created_at AT TIME ZONE 'UTC') < d.day + interval '1 day') AS trips
        FROM days d ORDER BY d.day`,
    ]);
    return {
      generatedAt: now.toISOString(),
      users: {
        total,
        registeredLast7Days: registered7,
        registeredLast30Days: registered30,
        activeLast7Days: active7,
        activeLast30Days: active30,
        suspended,
      },
      trips: {
        createdLast30Days: created30,
        completedLast30Days: completed30,
        upcoming,
        hidden,
      },
      reports: { open, inReview, urgent },
      operators: { pendingVerification: pendingOperators },
      bookings: null,
      daily: daily.map((row) => ({
        date: row.day,
        registrations: row.registrations,
        tripsCreated: row.trips,
      })),
    };
  }

  /** Staff who can take reports, for the assignment picker. */
  async staff(): Promise<StaffPerson[]> {
    const rows = await this.prisma.user.findMany({
      where: { role: { in: ['SUPER_ADMIN', 'MODERATOR'] }, status: 'ACTIVE', deletedAt: null },
      select: staffPersonSelect,
      orderBy: { displayName: 'asc' },
      take: 200,
    });
    return rows.map(staffPerson);
  }

  async audit(query: z.output<typeof AuditQuerySchema>): Promise<{
    data: AuditEntry[];
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const cursor = decodeCursor(query.cursor);
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.auditLog.findMany({
      where,
      select: auditSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toAuditEntry), page: page.page };
  }

  /** The latest audit entries about one thing, for detail screens. */
  async historyOf(entityType: string, entityId: string, take = 50): Promise<AuditEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      select: auditSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return rows.map(toAuditEntry);
  }
}
