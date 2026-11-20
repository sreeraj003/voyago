import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'node:crypto';
import { type Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { geographyPoint, setPointSql } from '../src/database/geo.js';

/**
 * Verifies the schema's integrity rules against the real Postgres/PostGIS database.
 * Every test runs inside a transaction that is always rolled back, so the database
 * (including any seed data) is left untouched.
 */

type Tx = Prisma.TransactionClient;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

class Rollback extends Error {}

/** Runs fn in a transaction and rolls it back. Returns fn's result. */
async function inRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      result = await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}

/** Asserts fn fails, and that the database error mentions `expected` (constraint name or code). */
async function expectDbError(fn: (tx: Tx) => Promise<unknown>, expected: string | RegExp) {
  let caught: unknown;
  try {
    await inRollback(fn);
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the database to reject the write').toBeDefined();
  const text = describeError(caught);
  if (typeof expected === 'string') expect(text).toContain(expected);
  else expect(text).toMatch(expected);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message, JSON.stringify((error as { meta?: unknown }).meta ?? {})];
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') parts.push(code);
  if (error.cause) parts.push(describeError(error.cause));
  return parts.join(' | ');
}

const unique = () => randomUUID().slice(0, 8);

async function createUser(tx: Tx, name = `t_${unique()}`) {
  return tx.user.create({ data: { username: name, displayName: `Test ${name}` } });
}

async function createTrip(
  tx: Tx,
  organiserId: string,
  overrides: Partial<Prisma.TripUncheckedCreateInput> = {},
) {
  return tx.trip.create({
    data: {
      organiserId,
      mode: 'RIDE',
      activityType: 'MOTORCYCLE_RIDE',
      title: 'Constraint test ride',
      originName: 'Hebbal',
      destinationName: 'Nandi Hills',
      departureAt: new Date('2030-01-05T00:00:00Z'),
      maxParticipants: 10,
      ...overrides,
    },
  });
}

async function createVerifiedPackage(tx: Tx, ownerId: string) {
  const operator = await tx.commercialOperator.create({
    data: {
      ownerUserId: ownerId,
      slug: `op-${unique()}`,
      legalName: 'Test Operator Pvt Ltd',
      displayName: 'Test Operator',
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
    },
  });
  return tx.commercialPackage.create({
    data: {
      operatorId: operator.id,
      mode: 'TRAVEL',
      activityType: 'TREK',
      title: 'Test trek',
      destinationName: 'Sakleshpur',
      durationDays: 2,
      pricePaise: 349_900,
      maxGroupSize: 10,
      cancellationPolicy: 'Test policy',
    },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('extensions', () => {
  it('has PostGIS and citext enabled', async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'citext') ORDER BY extname`;
    expect(rows.map((r) => r.extname)).toEqual(['citext', 'postgis']);
  });
});

describe('uniqueness', () => {
  it('rejects a duplicate username, case-insensitively', async () => {
    await expectDbError(async (tx) => {
      await createUser(tx, 'Rider_One');
      await createUser(tx, 'rider_one');
    }, 'P2002');
  });

  it('rejects a duplicate email, case-insensitively', async () => {
    await expectDbError(async (tx) => {
      await tx.user.create({
        data: { username: `a_${unique()}`, displayName: 'A', email: 'Same@Example.com' },
      });
      await tx.user.create({
        data: { username: `b_${unique()}`, displayName: 'B', email: 'same@example.com' },
      });
    }, 'P2002');
  });

  it('rejects following the same person twice', async () => {
    await expectDbError(async (tx) => {
      const [a, b] = [await createUser(tx), await createUser(tx)];
      await tx.follow.create({ data: { followerId: a.id, followeeId: b.id } });
      await tx.follow.create({ data: { followerId: a.id, followeeId: b.id } });
    }, 'P2002');
  });

  it('rejects joining the same trip twice', async () => {
    await expectDbError(async (tx) => {
      const [organiser, rider] = [await createUser(tx), await createUser(tx)];
      const trip = await createTrip(tx, organiser.id);
      await tx.tripParticipant.create({ data: { tripId: trip.id, userId: rider.id } });
      await tx.tripParticipant.create({ data: { tripId: trip.id, userId: rider.id } });
    }, 'P2002');
  });

  it('allows only one organiser per trip', async () => {
    await expectDbError(async (tx) => {
      const [a, b] = [await createUser(tx), await createUser(tx)];
      const trip = await createTrip(tx, a.id);
      await tx.tripParticipant.create({
        data: { tripId: trip.id, userId: a.id, role: 'ORGANISER' },
      });
      await tx.tripParticipant.create({
        data: { tripId: trip.id, userId: b.id, role: 'ORGANISER' },
      });
    }, 'trip_participants_one_organiser');
  });

  it('rejects a duplicate community membership', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      const community = await tx.community.create({
        data: { slug: `c-${unique()}`, name: 'Test', createdById: user.id },
      });
      await tx.communityMember.create({ data: { communityId: community.id, userId: user.id } });
      await tx.communityMember.create({ data: { communityId: community.id, userId: user.id } });
    }, 'P2002');
  });

  it('keeps one join request row per user and trip', async () => {
    await expectDbError(async (tx) => {
      const [organiser, rider] = [await createUser(tx), await createUser(tx)];
      const trip = await createTrip(tx, organiser.id);
      await tx.tripJoinRequest.create({ data: { tripId: trip.id, userId: rider.id } });
      await tx.tripJoinRequest.create({ data: { tripId: trip.id, userId: rider.id } });
    }, 'P2002');
  });
});

describe('foreign keys and delete behaviour', () => {
  it('rejects a participant for a trip that does not exist', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      await tx.tripParticipant.create({ data: { tripId: randomUUID(), userId: user.id } });
    }, 'P2003');
  });

  it('cascades stops, participants and join requests when a trip is deleted', async () => {
    const remaining = await inRollback(async (tx) => {
      const [organiser, rider] = [await createUser(tx), await createUser(tx)];
      const trip = await createTrip(tx, organiser.id);
      await tx.tripParticipant.create({
        data: { tripId: trip.id, userId: organiser.id, role: 'ORGANISER' },
      });
      await tx.tripJoinRequest.create({ data: { tripId: trip.id, userId: rider.id } });
      await tx.$executeRaw`
        INSERT INTO "trip_stops" ("id", "trip_id", "position", "name", "location", "updated_at")
        VALUES (gen_random_uuid(), ${trip.id}::uuid, 1, 'Stop',
                ${geographyPoint({ latitude: 13.2, longitude: 77.7 })}, now())`;
      await tx.trip.delete({ where: { id: trip.id } });
      return Promise.all([
        tx.tripParticipant.count({ where: { tripId: trip.id } }),
        tx.tripJoinRequest.count({ where: { tripId: trip.id } }),
        tx.tripStop.count({ where: { tripId: trip.id } }),
      ]);
    });
    expect(remaining).toEqual([0, 0, 0]);
  });

  it('prevents deleting a user who organises trips (users are soft-deleted)', async () => {
    await expectDbError(async (tx) => {
      const organiser = await createUser(tx);
      await createTrip(tx, organiser.id);
      await tx.user.delete({ where: { id: organiser.id } });
    }, /P2003|P2014|foreign key/i);
  });

  it('keeps a report when the reporter account is erased', async () => {
    const reporterId = await inRollback(async (tx) => {
      const [reporter, other] = [await createUser(tx), await createUser(tx)];
      const report = await tx.report.create({
        data: {
          reporterId: reporter.id,
          targetType: 'USER',
          targetId: other.id,
          reportedUserId: other.id,
          reason: 'SPAM',
        },
      });
      await tx.user.delete({ where: { id: reporter.id } });
      return (await tx.report.findUniqueOrThrow({ where: { id: report.id } })).reporterId;
    });
    expect(reporterId).toBeNull();
  });
});

describe('check constraints', () => {
  it('rejects following yourself', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      await tx.follow.create({ data: { followerId: user.id, followeeId: user.id } });
    }, 'follows_not_self');
  });

  it('rejects an invalid username', async () => {
    await expectDbError((tx) => createUser(tx, 'no spaces allowed'), 'users_username_format');
  });

  it('rejects a Ride trip that is not a motorcycle ride', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      await createTrip(tx, user.id, { mode: 'RIDE', activityType: 'BACKPACKING' });
    }, 'trips_mode_matches_activity');
  });

  it('rejects publishing a trip without mapped locations', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      await createTrip(tx, user.id, { status: 'PUBLISHED' });
    }, 'trips_published_has_locations');
  });

  it('rejects a return before departure and bad participant limits', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      await createTrip(tx, user.id, { returnAt: new Date('2029-12-31T00:00:00Z') });
    }, 'trips_return_after_departure');
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      await createTrip(tx, user.id, { minParticipants: 8, maxParticipants: 4 });
    }, 'trips_participant_limits');
  });

  it('rejects negative money and ratings outside 1 to 5', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      await createTrip(tx, user.id, { estimatedBudgetPaise: -100 });
    }, 'trips_budget_non_negative');
    await expectDbError(async (tx) => {
      const [a, b] = [await createUser(tx), await createUser(tx)];
      const trip = await createTrip(tx, a.id);
      await tx.review.create({
        data: { tripId: trip.id, reviewerId: b.id, revieweeId: a.id, rating: 6 },
      });
    }, 'reviews_rating_range');
  });

  it('limits live location sessions to 24 hours', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      const trip = await createTrip(tx, user.id);
      const startedAt = new Date('2030-01-05T00:00:00Z');
      await tx.locationSession.create({
        data: {
          tripId: trip.id,
          userId: user.id,
          startedAt,
          expiresAt: new Date(startedAt.getTime() + 25 * 3600_000),
        },
      });
    }, 'location_sessions_time_limited');
  });

  it('rejects a refund larger than the payment', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      const pkg = await createVerifiedPackage(tx, user.id);
      const booking = await tx.booking.create({
        data: {
          userId: user.id,
          packageId: pkg.id,
          seats: 1,
          unitPricePaise: 349_900,
          totalAmountPaise: 349_900,
        },
      });
      await tx.payment.create({
        data: {
          userId: user.id,
          bookingId: booking.id,
          provider: 'test',
          amountPaise: 349_900,
          refundedAmountPaise: 400_000,
          idempotencyKey: unique(),
        },
      });
    }, 'payments_refund_within_amount');
  });
});

describe('community trips stay separate from commercial bookings', () => {
  it('rejects a community trip that carries a commercial package', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      const pkg = await createVerifiedPackage(tx, user.id);
      await createTrip(tx, user.id, { tripType: 'COMMUNITY_FREE', commercialPackageId: pkg.id });
    }, 'trips_commercial_requires_package');
  });

  it('rejects a booking on a free community trip', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      const pkg = await createVerifiedPackage(tx, user.id);
      const communityTrip = await createTrip(tx, user.id);
      await tx.booking.create({
        data: {
          userId: user.id,
          packageId: pkg.id,
          tripId: communityTrip.id,
          seats: 1,
          unitPricePaise: 349_900,
          totalAmountPaise: 349_900,
        },
      });
    }, 'Bookings can only reference COMMERCIAL_PAID trips');
  });

  it('rejects publishing a package from an unverified operator', async () => {
    await expectDbError(async (tx) => {
      const user = await createUser(tx);
      const operator = await tx.commercialOperator.create({
        data: { ownerUserId: user.id, slug: `op-${unique()}`, legalName: 'X', displayName: 'X' },
      });
      await tx.commercialPackage.create({
        data: {
          operatorId: operator.id,
          mode: 'TRAVEL',
          activityType: 'TREK',
          title: 'Unverified',
          destinationName: 'Coorg',
          durationDays: 1,
          pricePaise: 100_00,
          maxGroupSize: 5,
          cancellationPolicy: 'x',
          status: 'PUBLISHED',
        },
      });
    }, 'Only VERIFIED operators can publish packages');
  });

  it('accepts a booking on a commercial departure of the same package', async () => {
    const status = await inRollback(async (tx) => {
      const [owner, traveller] = [await createUser(tx), await createUser(tx)];
      const pkg = await createVerifiedPackage(tx, owner.id);
      const departure = await createTrip(tx, owner.id, {
        mode: 'TRAVEL',
        activityType: 'TREK',
        tripType: 'COMMERCIAL_PAID',
        commercialPackageId: pkg.id,
      });
      const booking = await tx.booking.create({
        data: {
          userId: traveller.id,
          packageId: pkg.id,
          tripId: departure.id,
          seats: 2,
          unitPricePaise: 349_900,
          platformFeePaise: 5_000,
          totalAmountPaise: 704_800,
        },
      });
      return booking.status;
    });
    expect(status).toBe('PENDING_PAYMENT');
  });
});

describe('audit log', () => {
  it('is append-only', async () => {
    await expectDbError(async (tx) => {
      const log = await tx.auditLog.create({
        data: { actorType: 'SYSTEM', action: 'test.event', entityType: 'test' },
      });
      await tx.auditLog.update({ where: { id: log.id }, data: { action: 'tampered' } });
    }, 'append-only');
    await expectDbError(async (tx) => {
      const log = await tx.auditLog.create({
        data: { actorType: 'SYSTEM', action: 'test.event', entityType: 'test' },
      });
      await tx.auditLog.delete({ where: { id: log.id } });
    }, 'append-only');
  });
});

describe('PostGIS', () => {
  it('stores trip points and finds trips by distance', async () => {
    const found = await inRollback(async (tx) => {
      const user = await createUser(tx);
      const trip = await createTrip(tx, user.id);
      await tx.$executeRaw(
        setPointSql('trips', 'origin', trip.id, { latitude: 13.0358, longitude: 77.597 }),
      );
      await tx.$executeRaw(
        setPointSql('trips', 'destination', trip.id, { latitude: 13.3702, longitude: 77.6835 }),
      );
      await tx.trip.update({ where: { id: trip.id }, data: { status: 'PUBLISHED' } });

      const cubbonPark = geographyPoint({ latitude: 12.9763, longitude: 77.5929 });
      const near = await tx.$queryRaw<{ id: string; km: number }[]>`
        SELECT "id", ST_Distance("origin", ${cubbonPark}) / 1000 AS km
        FROM "trips" WHERE "id" = ${trip.id}::uuid AND ST_DWithin("origin", ${cubbonPark}, 25000)`;
      const far = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "trips" WHERE "id" = ${trip.id}::uuid AND ST_DWithin("origin", ${cubbonPark}, 5000)`;
      return { near, far };
    });
    expect(found.near).toHaveLength(1);
    expect(found.near[0]?.km).toBeGreaterThan(6);
    expect(found.near[0]?.km).toBeLessThan(8);
    expect(found.far).toHaveLength(0);
  });

  it('uses a GiST index for trip origin', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'trips' AND indexname = 'trips_origin_idx'`;
    expect(rows[0]?.indexdef).toContain('USING gist');
  });
});
