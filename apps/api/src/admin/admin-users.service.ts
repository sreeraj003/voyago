import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type AdminUserDetail,
  type AdminUsersQuerySchema,
  type AdminUserSummary,
  hasPermission,
  isStaffRole,
  maskEmail,
  maskPhone,
  type UserRole,
} from '@voyago/shared';
import { type z } from 'zod';
import { RealtimeService } from '../chat/realtime.service.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { AdminReportsService } from './admin-reports.service.js';
import { recordAudit } from './audit.js';
import { type Actor } from './permissions.js';

const userSummarySelect = {
  id: true,
  username: true,
  displayName: true,
  role: true,
  status: true,
  homeCity: true,
  email: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  createdAt: true,
  lastActiveAt: true,
  deletedAt: true,
  _count: { select: { reportsAgainst: { where: { status: { in: ['OPEN', 'IN_REVIEW'] } } } } },
} as const satisfies Prisma.UserSelect;

type UserSummaryRow = Prisma.UserGetPayload<{ select: typeof userSummarySelect }>;

function toSummary(row: UserSummaryRow): AdminUserSummary {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    homeCity: row.homeCity,
    maskedEmail: maskEmail(row.email),
    emailVerified: row.emailVerifiedAt !== null,
    phoneVerified: row.phoneVerifiedAt !== null,
    openReportsAgainst: row._count.reportsAgainst,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
    deleted: row.deletedAt !== null,
  };
}

/**
 * Member search, account detail, suspension and staff roles.
 *
 * Contact details are masked: staff see that an email or phone exists and whether it is
 * verified, never the full value. Moderators cannot act on staff accounts, and nobody can act
 * on their own account (so a super admin cannot lock themselves, or the last admin, out).
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly overview: AdminOverviewService,
    private readonly reports: AdminReportsService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(query: z.output<typeof AdminUsersQuerySchema>) {
    const cursor = decodeCursor(query.cursor);
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(q
        ? {
            OR: [
              { username: { contains: q.replace(/^@/, ''), mode: 'insensitive' } },
              { displayName: { contains: q, mode: 'insensitive' } },
              ...(q.includes('@') && !q.startsWith('@') ? [{ email: q.toLowerCase() }] : []),
              ...(/^[0-9a-f-]{36}$/i.test(q) ? [{ id: q.toLowerCase() }] : []),
            ],
          }
        : {}),
      ...(cursor
        ? {
            AND: [
              {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.user.findMany({
      where,
      select: userSummarySelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toSummary), page: page.page };
  }

  async get(actor: Actor, id: string): Promise<AdminUserDetail> {
    const row = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...userSummarySelect,
        bio: true,
        phone: true,
        motorcycles: {
          select: {
            id: true,
            make: true,
            model: true,
            nickname: true,
            verificationStatus: true,
          },
          orderBy: { createdAt: 'asc' },
        },
        operator: { select: { id: true, displayName: true, verificationStatus: true } },
        _count: {
          select: {
            organisedTrips: true,
            reportsAgainst: true,
            reportsFiled: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Member not found');
    const [openAgainst, reportsAgainst, history] = await Promise.all([
      this.prisma.report.count({
        where: { reportedUserId: id, status: { in: ['OPEN', 'IN_REVIEW'] } },
      }),
      this.reports.summariesWhere({ reportedUserId: id }, 25),
      this.overview.historyOf('user', id),
    ]);
    const lastSuspension = history.find((entry) => entry.action === 'user.suspend');
    return {
      ...toSummary({ ...row, _count: { reportsAgainst: openAgainst } }),
      bio: row.bio,
      maskedPhone: maskPhone(row.phone),
      suspension:
        row.status === 'SUSPENDED'
          ? {
              reason: lastSuspension?.reason ?? null,
              at: lastSuspension?.createdAt ?? row.createdAt.toISOString(),
            }
          : null,
      counts: {
        tripsOrganised: row._count.organisedTrips,
        reportsAgainst: row._count.reportsAgainst,
        reportsFiled: row._count.reportsFiled,
      },
      motorcycles: row.motorcycles.map((bike) => ({
        id: bike.id,
        label: bike.nickname
          ? `${bike.nickname} (${bike.make} ${bike.model})`
          : `${bike.make} ${bike.model}`,
        verificationStatus: bike.verificationStatus,
      })),
      operator: row.operator,
      reportsAgainst,
      history,
      actions: this.actionsFor(actor, row),
    };
  }

  async suspend(actor: Actor, id: string, reason: string): Promise<AdminUserDetail> {
    const target = await this.loadTarget(actor, id);
    if (target.status !== 'ACTIVE')
      throw new ConflictException('Only active accounts can be suspended');
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id, status: 'ACTIVE', deletedAt: null },
        data: { status: 'SUSPENDED' },
      });
      if (changed.count === 0)
        throw new ConflictException('The account changed. Reload and try again.');
      // Sign the member out everywhere; the auth guard already refuses non-active accounts.
      await tx.authSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'account_inactive' },
      });
      await recordAudit(tx, actor, {
        action: 'user.suspend',
        entityType: 'user',
        entityId: id,
        reason,
        metadata: { previousStatus: target.status },
      });
    });
    this.realtime.disconnectUser(id);
    return this.get(actor, id);
  }

  async restore(actor: Actor, id: string, reason: string): Promise<AdminUserDetail> {
    const target = await this.loadTarget(actor, id);
    if (target.status !== 'SUSPENDED') {
      throw new ConflictException('Only suspended accounts can be restored');
    }
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id, status: 'SUSPENDED', deletedAt: null },
        data: { status: 'ACTIVE' },
      });
      if (changed.count === 0)
        throw new ConflictException('The account changed. Reload and try again.');
      await recordAudit(tx, actor, {
        action: 'user.restore',
        entityType: 'user',
        entityId: id,
        reason,
        metadata: { previousStatus: target.status },
      });
    });
    return this.get(actor, id);
  }

  /** Super admins grant or remove staff roles. Takes effect on the member's next request. */
  async setRole(
    actor: Actor,
    id: string,
    role: UserRole,
    reason: string,
  ): Promise<AdminUserDetail> {
    const target = await this.loadTarget(actor, id);
    if (target.role === role)
      throw new ConflictException(`This account already has the ${role} role`);
    if (target.status !== 'ACTIVE' && role !== 'USER') {
      throw new ConflictException('Staff roles can only be given to active accounts');
    }
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id, role: target.role, deletedAt: null },
        data: { role },
      });
      if (changed.count === 0)
        throw new ConflictException('The account changed. Reload and try again.');
      await recordAudit(tx, actor, {
        action: 'user.role_change',
        entityType: 'user',
        entityId: id,
        reason,
        metadata: { from: target.role, to: role },
      });
    });
    return this.get(actor, id);
  }

  /** The account to act on, refusing your own account and (for non-super admins) staff. */
  private async loadTarget(actor: Actor, id: string) {
    const target = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, role: true, status: true },
    });
    if (!target) throw new NotFoundException('Member not found');
    if (target.id === actor.user.id) {
      throw new ForbiddenException('You cannot change your own account here');
    }
    if (isStaffRole(target.role) && actor.user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only a super admin can act on staff accounts');
    }
    return target;
  }

  private actionsFor(
    actor: Actor,
    target: { id: string; role: UserRole; status: string; deletedAt: Date | null },
  ): AdminUserDetail['actions'] {
    if (target.deletedAt || target.id === actor.user.id) return [];
    if (isStaffRole(target.role) && actor.user.role !== 'SUPER_ADMIN') return [];
    const actions: AdminUserDetail['actions'] = [];
    if (hasPermission(actor.user.role, 'users.suspend')) {
      if (target.status === 'ACTIVE') actions.push('suspend');
      if (target.status === 'SUSPENDED') actions.push('restore');
    }
    if (hasPermission(actor.user.role, 'users.role')) actions.push('role');
    return actions;
  }
}
