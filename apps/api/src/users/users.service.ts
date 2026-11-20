import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MAX_MOTORCYCLES_PER_USER,
  type Motorcycle,
  type MotorcycleInput,
  type Preferences,
  type PrivateProfile,
  type PublicProfile,
  type UpdatePreferencesSchema,
  type UpdateProfileSchema,
  type UpdateMotorcycleSchema,
} from '@voyago/shared';
import { type z } from 'zod';
import { directMessageAllowed } from '../chat/message-permission.js';
import { PrismaService } from '../database/prisma.service.js';

const motorcycleSelect = {
  id: true,
  make: true,
  model: true,
  year: true,
  engineCc: true,
  category: true,
  nickname: true,
  isPrimary: true,
  verificationStatus: true,
} as const;

const preferenceSelect = {
  preferredMode: true,
  interests: true,
  preferredActivities: true,
  travelStyles: true,
  preferredDestinations: true,
  budgetMinPaise: true,
  budgetMaxPaise: true,
  groupSizeMin: true,
  groupSizeMax: true,
  ridingExperience: true,
  profileVisibility: true,
  allowMessagesFrom: true,
  pushEnabled: true,
  emailEnabled: true,
} as const;

/**
 * Profiles, preferences and motorcycles.
 *
 * Privacy rules live here and are covered by e2e tests:
 * - email and phone are returned only by `getOwnProfile`;
 * - a block in either direction makes a profile not found (404), as does a suspended account;
 * - PRIVATE profiles, and FOLLOWERS profiles seen by non-followers, show only the basics.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwnProfile(userId: string): Promise<PrivateProfile> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: null,
      homeCity: user.homeCity,
      country: user.country,
      languages: user.languages,
      email: user.email,
      phone: user.phone,
      verification: { email: user.emailVerifiedAt !== null, phone: user.phoneVerifiedAt !== null },
      hasPassword: user.passwordHash !== null,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
    };
  }

  async updateOwnProfile(
    userId: string,
    input: z.output<typeof UpdateProfileSchema>,
  ): Promise<PrivateProfile> {
    if (input.username) {
      const taken = await this.prisma.user.findFirst({
        where: { username: input.username, id: { not: userId } },
        select: { id: true },
      });
      if (taken) throw new ConflictException('This username is taken');
    }
    await this.prisma.user.update({ where: { id: userId }, data: input });
    return this.getOwnProfile(userId);
  }

  async getPublicProfile(viewerId: string, username: string): Promise<PublicProfile> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      include: {
        preferences: { select: preferenceSelect },
        motorcycles: {
          select: motorcycleSelect,
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });
    const notFound = new NotFoundException('Profile not found');
    if (!user || user.status !== 'ACTIVE' || user.deletedAt) throw notFound;

    const isSelf = user.id === viewerId;
    if (!isSelf) {
      const block = await this.prisma.userBlock.findFirst({
        where: {
          OR: [
            { blockerId: user.id, blockedId: viewerId },
            { blockerId: viewerId, blockedId: user.id },
          ],
        },
        select: { blockerId: true },
      });
      if (block) throw notFound;
    }

    const [followerCount, followingCount, links] = await Promise.all([
      this.prisma.follow.count({ where: { followeeId: user.id } }),
      this.prisma.follow.count({ where: { followerId: user.id } }),
      isSelf
        ? []
        : this.prisma.follow.findMany({
            where: {
              OR: [
                { followerId: viewerId, followeeId: user.id },
                { followerId: user.id, followeeId: viewerId },
              ],
            },
            select: { followerId: true },
          }),
    ]);
    const isFollowing = links.some((link) => link.followerId === viewerId);
    const visibility = user.preferences?.profileVisibility ?? 'PUBLIC';
    const full = isSelf || visibility === 'PUBLIC' || (visibility === 'FOLLOWERS' && isFollowing);
    // Whether they follow you back is shown only where their profile is visible to you.
    const followsYou = full && links.some((link) => link.followerId === user.id);
    const follow = {
      followerCount,
      followingCount,
      isFollowing,
      followsYou,
      mutual: isFollowing && followsYou,
    };

    const base = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: null,
      verification: { email: user.emailVerifiedAt !== null, phone: user.phoneVerifiedAt !== null },
      memberSince: user.createdAt.toISOString(),
      follow,
      canMessage: isSelf ? false : await directMessageAllowed(this.prisma, viewerId, user.id),
    };
    if (!full) {
      return {
        ...base,
        limited: true,
        bio: null,
        homeCity: null,
        country: null,
        languages: [],
        interests: [],
        travelStyles: [],
        ridingExperience: null,
        motorcycles: [],
      };
    }
    return {
      ...base,
      limited: false,
      bio: user.bio,
      homeCity: user.homeCity,
      country: user.country,
      languages: user.languages,
      interests: user.preferences?.interests ?? [],
      travelStyles: user.preferences?.travelStyles ?? [],
      ridingExperience: user.preferences?.ridingExperience ?? null,
      // Nicknames stay private; registration numbers and documents are never stored here.
      motorcycles: user.motorcycles.map(({ nickname: _nickname, ...bike }) => bike),
    };
  }

  async getPreferences(userId: string): Promise<Preferences> {
    return this.prisma.userPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: preferenceSelect,
    });
  }

  async updatePreferences(
    userId: string,
    input: z.output<typeof UpdatePreferencesSchema>,
  ): Promise<Preferences> {
    // Ranges are checked against the stored values too; the database CHECK is the backstop.
    const current = await this.getPreferences(userId);
    const merged = { ...current, ...input };
    if (
      merged.budgetMinPaise !== null &&
      merged.budgetMaxPaise !== null &&
      merged.budgetMinPaise > merged.budgetMaxPaise
    ) {
      throw rangeError('budgetMinPaise', 'Minimum budget must not exceed maximum');
    }
    if (
      merged.groupSizeMin !== null &&
      merged.groupSizeMax !== null &&
      merged.groupSizeMin > merged.groupSizeMax
    ) {
      throw rangeError('groupSizeMin', 'Minimum group size must not exceed maximum');
    }
    return this.prisma.userPreference.update({
      where: { userId },
      data: input,
      select: preferenceSelect,
    });
  }

  listMotorcycles(userId: string): Promise<Motorcycle[]> {
    return this.prisma.motorcycle.findMany({
      where: { ownerId: userId },
      select: motorcycleSelect,
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async addMotorcycle(userId: string, input: MotorcycleInput): Promise<Motorcycle> {
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.motorcycle.count({ where: { ownerId: userId } });
      if (count >= MAX_MOTORCYCLES_PER_USER) {
        throw new ConflictException(`You can add up to ${MAX_MOTORCYCLES_PER_USER} motorcycles`);
      }
      // The first motorcycle is the primary one unless stated otherwise.
      const isPrimary = input.isPrimary ?? count === 0;
      if (isPrimary) {
        await tx.motorcycle.updateMany({ where: { ownerId: userId }, data: { isPrimary: false } });
      }
      return tx.motorcycle.create({
        data: { ...input, isPrimary, ownerId: userId },
        select: motorcycleSelect,
      });
    });
  }

  async updateMotorcycle(
    userId: string,
    id: string,
    input: z.output<typeof UpdateMotorcycleSchema>,
  ): Promise<Motorcycle> {
    return this.prisma.$transaction(async (tx) => {
      // Ownership is part of every query: another member's motorcycle is simply not found.
      const owned = await tx.motorcycle.findFirst({
        where: { id, ownerId: userId },
        select: { id: true },
      });
      if (!owned) throw new NotFoundException('Motorcycle not found');
      if (input.isPrimary) {
        await tx.motorcycle.updateMany({
          where: { ownerId: userId, id: { not: id } },
          data: { isPrimary: false },
        });
      }
      return tx.motorcycle.update({ where: { id }, data: input, select: motorcycleSelect });
    });
  }

  async deleteMotorcycle(userId: string, id: string): Promise<void> {
    const deleted = await this.prisma.motorcycle.deleteMany({ where: { id, ownerId: userId } });
    if (deleted.count !== 1) throw new NotFoundException('Motorcycle not found');
  }
}

function rangeError(path: string, message: string) {
  return new BadRequestException({ message: 'Validation failed', details: [{ path, message }] });
}
