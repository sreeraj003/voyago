import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  type Entitlement,
  ENTITLEMENTS_BY_TIER,
  RENEWAL_GRACE_HOURS,
  type Tier,
  TIER_NAMES,
  tierFor,
  UPGRADE_REQUIRED,
} from '@voyago/shared';
import { PrismaService } from '../database/prisma.service.js';

const HOUR_MS = 3_600_000;

type SubscriptionState = {
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

/**
 * Whether a subscription's paid features work at `now`. Decided by the server from the stored
 * subscription and the clock, so an expiry needs no webhook to take effect:
 * - active or retrying a renewal: until the period end, plus a short grace while the renewal
 *   charge goes through;
 * - cancelled: until the end of the period already paid for, no grace;
 * - waiting for the first payment, or expired: never.
 */
export function isEntitled(sub: SubscriptionState, now = new Date()): boolean {
  if (!sub.currentPeriodEnd) return false;
  const end = sub.currentPeriodEnd.getTime();
  switch (sub.status) {
    case 'ACTIVE':
    case 'TRIALING':
    case 'PAST_DUE':
      return now.getTime() < end + (sub.cancelAtPeriodEnd ? 0 : RENEWAL_GRACE_HOURS * HOUR_MS);
    case 'CANCELLED':
      return now.getTime() < end;
    default:
      return false;
  }
}

/**
 * Entitlements: the server-side answer to "may this member use this paid feature now?". Every
 * paid endpoint calls `require`; the app's flags only decide what to show.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  async tierOf(userId: string, now = new Date()): Promise<Tier> {
    const subs = await this.prisma.subscription.findMany({
      where: {
        userId,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELLED'] },
        currentPeriodEnd: { gt: new Date(now.getTime() - RENEWAL_GRACE_HOURS * HOUR_MS) },
      },
      select: {
        status: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        plan: { select: { tier: true } },
      },
    });
    let tier: Tier = 'FREE';
    for (const sub of subs) {
      if (!isEntitled(sub, now)) continue;
      if (sub.plan.tier === 'ORGANISER_PRO') return 'ORGANISER_PRO';
      tier = 'EXPLORER_PRO';
    }
    return tier;
  }

  async entitlementsOf(userId: string, now = new Date()) {
    const tier = await this.tierOf(userId, now);
    return { tier, entitlements: [...ENTITLEMENTS_BY_TIER[tier]] };
  }

  async has(userId: string, entitlement: Entitlement, now = new Date()): Promise<boolean> {
    return ENTITLEMENTS_BY_TIER[await this.tierOf(userId, now)].includes(entitlement);
  }

  /** Throws 403 naming the plan that includes the feature. */
  async require(userId: string, entitlement: Entitlement): Promise<void> {
    if (await this.has(userId, entitlement)) return;
    const tier = tierFor(entitlement);
    throw new ForbiddenException({
      message: `This is part of ${TIER_NAMES[tier]}`,
      details: [{ path: UPGRADE_REQUIRED, message: tier }],
    });
  }
}
