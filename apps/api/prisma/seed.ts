/**
 * DEVELOPMENT-ONLY SAMPLE DATA.
 *
 * Creates a small, clearly fake data set for local development: users named dev_*,
 * @example.com addresses (a reserved domain), and trips around Bengaluru.
 * It contains no secrets and no real people. It is idempotent: every row has a fixed id
 * and is upserted, so running it twice changes nothing.
 *
 * Safety: refuses to run when NODE_ENV=production, or against a non-local database
 * unless ALLOW_REMOTE_SEED=true is set explicitly.
 *
 * Run: pnpm db:seed   (or: pnpm --filter @voyago/api db:seed)
 */
import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { type GeoPoint } from '@voyago/shared';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { setPointSql } from '../src/database/geo.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

function assertSafeToSeed(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production.');
  }
  const host = new URL(databaseUrl).hostname;
  if (!LOCAL_HOSTS.has(host) && process.env.ALLOW_REMOTE_SEED !== 'true') {
    throw new Error(
      `Refusing to seed non-local database host "${host}". Set ALLOW_REMOTE_SEED=true if this is a disposable dev database.`,
    );
  }
  return databaseUrl;
}

// Fixed ids keep the seed idempotent. The "5eed" prefix makes seed rows easy to spot.
const id = (n: number) => `5eed0000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const USERS = {
  asha: id(1),
  vikram: id(2),
  meera: id(3),
  rahul: id(4),
} as const;
const COMMUNITY = id(100);
const TRIPS = {
  nandi: id(200),
  coorg: id(201),
  chikmagalur: id(202),
  sakleshpur: id(203),
} as const;
const OPERATOR = id(300);
const PACKAGE = id(301);
const CONVERSATION = id(400);
const JOIN_REQUEST = id(600);
const PLANS = { explorer: id(500), organiser: id(501) } as const;

const PLACES: Record<string, GeoPoint> = {
  hebbal: { latitude: 13.0358, longitude: 77.597 },
  devanahalli: { latitude: 13.2437, longitude: 77.7172 },
  nandiHills: { latitude: 13.3702, longitude: 77.6835 },
  majestic: { latitude: 12.9767, longitude: 77.5713 },
  mysuru: { latitude: 12.2958, longitude: 76.6394 },
  madikeri: { latitude: 12.4244, longitude: 75.7382 },
  sakleshpur: { latitude: 12.944, longitude: 75.7849 },
};

/** Next Saturday at the given IST hour, so sample trips are always in the future. */
function nextSaturday(hourIst: number, weeksAhead = 0): Date {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourIst - 5, -30),
  );
  const daysUntilSaturday = (6 - date.getUTCDay() + 7) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + daysUntilSaturday + weeksAhead * 7);
  return date;
}

/**
 * Password for the sample dev_* accounts, so the apps can sign in locally. These accounts are
 * fake and the seed refuses to run against production or non-local databases.
 */
const DEV_PASSWORD = process.env.SEED_DEV_PASSWORD ?? 'voyago-dev-password';

async function main(): Promise<void> {
  const devPasswordHash = await hash(DEV_PASSWORD, {
    algorithm: 2,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: assertSafeToSeed(process.env.DATABASE_URL) }),
  });

  try {
    await prisma.$transaction(async (tx) => {
      // ── Users ────────────────────────────────────────────────────────────
      const users = [
        {
          id: USERS.asha,
          username: 'dev_asha',
          displayName: 'Asha (dev)',
          homeCity: 'Bengaluru',
          bio: 'Sample rider. Sunrise rides and filter coffee.',
        },
        {
          id: USERS.vikram,
          username: 'dev_vikram',
          displayName: 'Vikram (dev)',
          homeCity: 'Bengaluru',
          bio: 'Sample traveller. Weekend getaways.',
        },
        {
          id: USERS.meera,
          username: 'dev_meera',
          displayName: 'Meera (dev)',
          homeCity: 'Bengaluru',
          bio: 'Sample organiser. Coorg every monsoon.',
        },
        {
          id: USERS.rahul,
          username: 'dev_rahul',
          displayName: 'Rahul (dev)',
          homeCity: 'Mysuru',
          bio: 'Sample operator owner.',
        },
      ];
      for (const user of users) {
        const data = { ...user, email: `${user.username}@example.com` };
        await tx.user.upsert({
          where: { id: user.id },
          create: { ...data, passwordHash: devPasswordHash, emailVerifiedAt: new Date() },
          update: data,
        });
      }
      // Accounts seeded before sign-in existed get the dev password once; later runs keep it.
      await tx.user.updateMany({
        where: { id: { in: users.map((u) => u.id) }, passwordHash: null },
        data: { passwordHash: devPasswordHash, emailVerifiedAt: new Date() },
      });

      await tx.userPreference.upsert({
        where: { userId: USERS.asha },
        create: {
          userId: USERS.asha,
          preferredMode: 'RIDE',
          interests: ['sunrise', 'photography'],
        },
        update: {},
      });
      await tx.userPreference.upsert({
        where: { userId: USERS.vikram },
        create: {
          userId: USERS.vikram,
          preferredMode: 'TRAVEL',
          interests: ['coffee estates', 'waterfalls'],
          budgetMinPaise: 200_000,
          budgetMaxPaise: 800_000,
        },
        update: {},
      });

      await tx.motorcycle.upsert({
        where: { id: id(10) },
        create: {
          id: id(10),
          ownerId: USERS.asha,
          make: 'Royal Enfield',
          model: 'Himalayan 450',
          year: 2024,
          engineCc: 452,
          category: 'ADVENTURE',
          isPrimary: true,
        },
        update: {},
      });

      // ── Social graph ─────────────────────────────────────────────────────
      const follows = [
        [USERS.vikram, USERS.asha],
        [USERS.asha, USERS.meera],
        [USERS.meera, USERS.asha],
      ] as const;
      for (const [followerId, followeeId] of follows) {
        await tx.follow.upsert({
          where: { followerId_followeeId: { followerId, followeeId } },
          create: { followerId, followeeId },
          update: {},
        });
      }

      await tx.community.upsert({
        where: { id: COMMUNITY },
        create: {
          id: COMMUNITY,
          slug: 'dev-bengaluru-weekend-riders',
          name: 'Bengaluru Weekend Riders (dev)',
          description: 'Development sample community.',
          mode: 'RIDE',
          city: 'Bengaluru',
          createdById: USERS.asha,
        },
        update: {},
      });
      for (const [userId, role] of [
        [USERS.asha, 'OWNER'],
        [USERS.vikram, 'MEMBER'],
      ] as const) {
        await tx.communityMember.upsert({
          where: { communityId_userId: { communityId: COMMUNITY, userId } },
          create: { communityId: COMMUNITY, userId, role },
          update: {},
        });
      }

      // ── Community trips ──────────────────────────────────────────────────
      // Trips are created as DRAFT (Prisma cannot write geography columns), given their
      // PostGIS points with raw SQL, then published.
      const trips = [
        {
          id: TRIPS.nandi,
          organiserId: USERS.asha,
          communityId: COMMUNITY,
          mode: 'RIDE' as const,
          activityType: 'MOTORCYCLE_RIDE' as const,
          title: 'Nandi Hills sunrise ride (dev sample)',
          description: 'Development sample trip. Easy pace, back by breakfast.',
          originName: 'Hebbal flyover',
          destinationName: 'Nandi Hills',
          departureAt: nextSaturday(5),
          maxParticipants: 12,
          estimatedDistanceKm: 120,
          minEngineCc: 150,
          difficulty: 'EASY' as const,
          origin: PLACES.hebbal!,
          destination: PLACES.nandiHills!,
          publish: true,
        },
        {
          id: TRIPS.coorg,
          organiserId: USERS.meera,
          communityId: null,
          mode: 'TRAVEL' as const,
          activityType: 'WEEKEND_GETAWAY' as const,
          title: 'Coorg coffee estate weekend (dev sample)',
          description: 'Development sample trip. Shared homestay, costs split equally.',
          originName: 'Majestic bus stand',
          destinationName: 'Madikeri, Coorg',
          departureAt: nextSaturday(6, 1),
          maxParticipants: 6,
          estimatedBudgetPaise: 450_000,
          estimatedDistanceKm: 265,
          difficulty: 'EASY' as const,
          origin: PLACES.majestic!,
          destination: PLACES.madikeri!,
          publish: true,
        },
        {
          id: TRIPS.chikmagalur,
          organiserId: USERS.asha,
          communityId: COMMUNITY,
          mode: 'RIDE' as const,
          activityType: 'MOTORCYCLE_RIDE' as const,
          title: 'Chikmagalur twisties (dev sample, draft)',
          description: 'Development sample draft. Route not mapped yet.',
          originName: 'Bengaluru',
          destinationName: 'Chikmagalur',
          departureAt: nextSaturday(5, 3),
          maxParticipants: 8,
          difficulty: 'MODERATE' as const,
          origin: null,
          destination: null,
          publish: false,
        },
      ];

      for (const { origin, destination, publish, ...trip } of trips) {
        await tx.trip.upsert({ where: { id: trip.id }, create: trip, update: {} });
        if (origin) await tx.$executeRaw(setPointSql('trips', 'origin', trip.id, origin));
        if (destination) {
          await tx.$executeRaw(setPointSql('trips', 'destination', trip.id, destination));
        }
        if (publish) {
          await tx.trip.update({
            where: { id: trip.id },
            data: { status: 'PUBLISHED', publishedAt: new Date() },
          });
        }
        await tx.tripParticipant.upsert({
          where: { tripId_userId: { tripId: trip.id, userId: trip.organiserId } },
          create: { tripId: trip.id, userId: trip.organiserId, role: 'ORGANISER' },
          update: {},
        });
      }

      // Stops: inserted with raw SQL because location is a required geography column.
      const stops = [
        {
          id: id(210),
          tripId: TRIPS.nandi,
          position: 1,
          name: 'Devanahalli fort (tea stop)',
          at: PLACES.devanahalli!,
        },
        {
          id: id(211),
          tripId: TRIPS.coorg,
          position: 1,
          name: 'Mysuru (lunch)',
          at: PLACES.mysuru!,
        },
      ];
      for (const stop of stops) {
        await tx.$executeRaw`
          INSERT INTO "trip_stops" ("id", "trip_id", "position", "name", "location", "updated_at")
          VALUES (${stop.id}::uuid, ${stop.tripId}::uuid, ${stop.position}, ${stop.name},
                  ST_SetSRID(ST_MakePoint(${stop.at.longitude}, ${stop.at.latitude}), 4326)::geography, now())
          ON CONFLICT ("id") DO NOTHING`;
      }

      await tx.tripParticipant.upsert({
        where: { tripId_userId: { tripId: TRIPS.nandi, userId: USERS.vikram } },
        create: { tripId: TRIPS.nandi, userId: USERS.vikram },
        update: {},
      });
      await tx.tripJoinRequest.upsert({
        where: { id: JOIN_REQUEST },
        create: {
          id: JOIN_REQUEST,
          tripId: TRIPS.coorg,
          userId: USERS.vikram,
          message: 'Sample join request: happy to share driving.',
        },
        update: {},
      });

      // ── Trip chat ────────────────────────────────────────────────────────
      await tx.conversation.upsert({
        where: { id: CONVERSATION },
        create: { id: CONVERSATION, type: 'TRIP_GROUP', tripId: TRIPS.nandi },
        update: {},
      });
      for (const [userId, role] of [
        [USERS.asha, 'ADMIN'],
        [USERS.vikram, 'MEMBER'],
      ] as const) {
        await tx.conversationMember.upsert({
          where: { conversationId_userId: { conversationId: CONVERSATION, userId } },
          create: { conversationId: CONVERSATION, userId, role },
          update: {},
        });
      }
      const messages = [
        {
          id: id(410),
          senderId: USERS.asha,
          body: 'Sample message: meet at 5:15, fuel up before.',
        },
        { id: id(411), senderId: USERS.vikram, body: 'Sample message: see you there!' },
      ];
      for (const message of messages) {
        await tx.message.upsert({
          where: { id: message.id },
          create: { ...message, conversationId: CONVERSATION },
          update: {},
        });
      }

      await tx.notification.upsert({
        where: { id: id(420) },
        create: {
          id: id(420),
          userId: USERS.meera,
          type: 'JOIN_REQUEST_RECEIVED',
          title: 'New join request (dev sample)',
          body: 'Vikram (dev) asked to join your Coorg trip.',
          data: { tripId: TRIPS.coorg },
        },
        update: {},
      });

      // ── Commercial (separate from community trips) ───────────────────────
      await tx.commercialOperator.upsert({
        where: { id: OPERATOR },
        create: {
          id: OPERATOR,
          ownerUserId: USERS.rahul,
          slug: 'dev-western-ghats-treks',
          legalName: 'Development Sample Operator (not a real business)',
          displayName: 'Western Ghats Treks (dev)',
          businessEmail: 'operator@example.com',
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date(),
        },
        update: {},
      });
      await tx.commercialPackage.upsert({
        where: { id: PACKAGE },
        create: {
          id: PACKAGE,
          operatorId: OPERATOR,
          mode: 'TRAVEL',
          activityType: 'TREK',
          title: 'Sakleshpur green route trek (dev sample)',
          description: 'Development sample package. Not for sale.',
          destinationName: 'Sakleshpur',
          durationDays: 2,
          pricePaise: 349_900,
          maxGroupSize: 15,
          inclusions: ['Guide', 'Homestay', 'Meals'],
          exclusions: ['Travel to Sakleshpur'],
          cancellationPolicy: 'Sample policy: full refund up to 72 hours before departure.',
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
        update: {},
      });
      await tx.$executeRaw(
        setPointSql('commercial_packages', 'destination', PACKAGE, PLACES.sakleshpur!),
      );
      await tx.trip.upsert({
        where: { id: TRIPS.sakleshpur },
        create: {
          id: TRIPS.sakleshpur,
          organiserId: USERS.rahul,
          commercialPackageId: PACKAGE,
          tripType: 'COMMERCIAL_PAID',
          mode: 'TRAVEL',
          activityType: 'TREK',
          title: 'Sakleshpur green route trek: departure (dev sample)',
          originName: 'Sakleshpur town',
          destinationName: 'Sakleshpur',
          departureAt: nextSaturday(7, 2),
          maxParticipants: 15,
        },
        update: {},
      });
      await tx.tripParticipant.upsert({
        where: { tripId_userId: { tripId: TRIPS.sakleshpur, userId: USERS.rahul } },
        create: { tripId: TRIPS.sakleshpur, userId: USERS.rahul, role: 'ORGANISER' },
        update: {},
      });

      // ── Subscription plans (proposed prices from the brief) ──────────────
      const plans = [
        {
          id: PLANS.explorer,
          code: 'EXPLORER_PRO_MONTHLY',
          name: 'Explorer Pro',
          description: 'Proposed plan for travellers. Price under review.',
          pricePaise: 11_900,
          billingInterval: 'MONTHLY' as const,
          features: { advancedFilters: true, unlimitedJoinRequests: true },
        },
        {
          id: PLANS.organiser,
          code: 'ORGANISER_PRO_MONTHLY',
          name: 'Organiser Pro',
          description: 'Proposed plan for frequent organisers. Price under review.',
          pricePaise: 69_900,
          billingInterval: 'MONTHLY' as const,
          features: { featuredTrips: 2, organiserAnalytics: true },
        },
      ];
      for (const plan of plans) {
        await tx.subscriptionPlan.upsert({ where: { code: plan.code }, create: plan, update: {} });
      }

      await tx.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: 'seed.run',
          entityType: 'database',
          metadata: { note: 'Development sample data loaded' },
        },
      });
    });

    console.warn('Seeded development sample data (users dev_*, trips around Bengaluru).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
