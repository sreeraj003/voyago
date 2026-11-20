import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type CheckIn,
  type CreateCheckInSchema,
  type CreateEmergencyContactSchema,
  EMERGENCY_NUMBER,
  type EmergencyContact,
  isTripLive,
  LOCATION_MAX_AGE_MS,
  LOCATION_MIN_INTERVAL_MS,
  type LocationPoint,
  type LocationSession,
  type LocationUpdateSchema,
  MAX_EMERGENCY_CONTACTS,
  type RaiseSosSchema,
  type SafetyPerson,
  type Sharer,
  type SosAlert,
  type SosResult,
  type StartSharingSchema,
  type TripSafety,
} from '@voyago/shared';
import { type z } from 'zod';
import { SMS_SENDER, type SmsSender } from '../auth/delivery/sms-sender.js';
import { RealtimeService } from '../chat/realtime.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RedisService } from '../redis/redis.service.js';
import { blockedIds } from '../social/blocks.js';
import { AFTER_TRIP_WINDOW_MS, isSafetyOpen } from '../trips/trip-view.js';

/** A device position sent with an SOS may be at most this old. */
const SOS_LOCATION_MAX_AGE_MS = 15 * 60 * 1000;
/** Clock skew tolerated on device timestamps. */
const FUTURE_SKEW_MS = 30_000;
const SOS_PER_HOUR = 3;

export type EndReason =
  'stopped' | 'trip_ended' | 'left_trip' | 'replaced' | 'expired' | 'suspended';

const pointKey = (tripId: string, userId: string) => `loc:${tripId}:${userId}`;
const rateKey = (userId: string) => `loc:rate:${userId}`;

const personSelect = { id: true, username: true, displayName: true } as const;

const alertInclude = {
  user: { select: personSelect },
  resolvedBy: { select: personSelect },
} as const satisfies Prisma.SosAlertInclude;
type AlertRow = Prisma.SosAlertGetPayload<{ include: typeof alertInclude }>;

function toAlert(row: AlertRow): SosAlert {
  return {
    id: row.id,
    tripId: row.tripId,
    user: row.user,
    status: row.status,
    message: row.message,
    location:
      row.latitude !== null && row.longitude !== null && row.locationRecordedAt
        ? {
            latitude: row.latitude,
            longitude: row.longitude,
            recordedAt: row.locationRecordedAt.toISOString(),
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
  };
}

function toSession(row: {
  id: string;
  tripId: string;
  status: LocationSession['status'];
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
}): LocationSession {
  return {
    id: row.id,
    tripId: row.tripId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

interface TripRow {
  id: string;
  title: string;
  status: string;
  departureAt: Date;
  completedAt: Date | null;
  organiserId: string;
}

/**
 * Live location, check-ins, emergency contacts and SOS.
 *
 * Only active members of a trip (the organiser and approved participants) can share or see
 * locations, and only during the trip's live window. Sharing is opt-in and ends by itself; the
 * coordinates are kept in Redis with a time-to-live equal to the session, never in PostgreSQL.
 * Blocks hide people from each other here too. Everything else answers 404, so trips can't be
 * probed.
 */
@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
  ) {}

  // ── Overview ──────────────────────────────────────────────────────────────

  async state(userId: string, tripId: string, now = Date.now()): Promise<TripSafety> {
    const trip = await this.loadMember(userId, tripId);
    await this.expireSessions({ tripId }, now);
    const hidden = await blockedIds(this.prisma, userId);
    const [mine, sharers, checkIns, alerts] = await Promise.all([
      this.prisma.locationSession.findFirst({
        where: { tripId, userId, status: 'ACTIVE' },
      }),
      this.sharers(tripId, hidden),
      this.prisma.tripCheckIn.findMany({
        where: { tripId, userId: { notIn: hidden } },
        include: { user: { select: personSelect } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.sosAlert.findMany({
        where: {
          tripId,
          userId: { notIn: hidden },
          OR: [{ status: 'ACTIVE' }, { createdAt: { gte: new Date(now - AFTER_TRIP_WINDOW_MS) } }],
        },
        include: alertInclude,
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    return {
      tripId,
      live: isTripLive(trip, now),
      mySession: mine ? toSession(mine) : null,
      sharers,
      checkIns: checkIns.map(toCheckIn),
      alerts: alerts.map(toAlert),
      emergencyNumber: EMERGENCY_NUMBER,
      smsAvailable: this.sms.sosEnabled,
    };
  }

  // ── Location sharing ──────────────────────────────────────────────────────

  async startSharing(
    userId: string,
    tripId: string,
    input: z.output<typeof StartSharingSchema>,
  ): Promise<LocationSession> {
    const trip = await this.loadMember(userId, tripId);
    this.assertLive(trip);
    const now = new Date();
    const session = await this.prisma.$transaction(async (tx) => {
      await tx.locationSession.updateMany({
        where: { tripId, userId, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: now, endReason: 'replaced' },
      });
      return tx.locationSession.create({
        data: {
          tripId,
          userId,
          startedAt: now,
          expiresAt: new Date(now.getTime() + input.durationMinutes * 60_000),
        },
      });
    });
    // A point kept from a replaced session gets the new session's lifetime.
    await this.redis.client
      .pexpire(pointKey(tripId, userId), session.expiresAt.getTime() - now.getTime())
      .catch(() => undefined);
    return toSession(session);
  }

  async stopSharing(userId: string, tripId: string): Promise<void> {
    await this.loadMember(userId, tripId);
    await this.endSessions({ tripId, userId }, 'stopped');
  }

  /**
   * One location reading. Refused without an active session in the live window, or faster than
   * once every few seconds. Readings that are too old, or older than the last one, are ignored
   * (`accepted: false`) so a reconnecting phone's queue can't move someone backwards.
   */
  async update(
    userId: string,
    tripId: string,
    input: z.output<typeof LocationUpdateSchema>,
    now = Date.now(),
  ): Promise<{ accepted: boolean }> {
    const recordedAt = new Date(input.recordedAt).getTime();
    if (recordedAt > now + FUTURE_SKEW_MS) {
      throw new HttpException(
        {
          message: 'Validation failed',
          details: [{ path: 'recordedAt', message: 'Is in the future' }],
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const trip = await this.loadMember(userId, tripId);
    const session = await this.prisma.locationSession.findFirst({
      where: { tripId, userId, status: 'ACTIVE' },
    });
    if (!session) throw new ConflictException('Start sharing your location first');
    if (session.expiresAt.getTime() <= now) {
      await this.endSessions({ tripId, userId }, 'expired');
      throw new ConflictException('Your location sharing has ended');
    }
    if (!isTripLive(trip, now)) {
      await this.endSessions({ tripId, userId }, 'trip_ended');
      throw new ConflictException('This trip is no longer live');
    }
    const client = this.redis.client;
    const allowed = await client.set(rateKey(userId), '1', 'PX', LOCATION_MIN_INTERVAL_MS, 'NX');
    if (allowed !== 'OK') {
      throw new HttpException('Location updates are too frequent', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (now - recordedAt > LOCATION_MAX_AGE_MS) return { accepted: false };
    const previous = await this.readPoint(tripId, userId);
    if (previous && new Date(previous.recordedAt).getTime() >= recordedAt) {
      return { accepted: false };
    }
    const point: LocationPoint = {
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters ?? null,
      heading: input.heading ?? null,
      speedMps: input.speedMps ?? null,
      recordedAt: new Date(recordedAt).toISOString(),
    };
    await client.set(
      pointKey(tripId, userId),
      JSON.stringify(point),
      'PX',
      Math.max(session.expiresAt.getTime() - now, 1),
    );
    const [user, audience] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: personSelect }),
      this.audience(tripId, userId),
    ]);
    this.realtime.emitToUsers(audience, 'location:update', {
      tripId,
      user,
      expiresAt: session.expiresAt.toISOString(),
      ...point,
    });
    return { accepted: true };
  }

  // ── Check-ins ─────────────────────────────────────────────────────────────

  async checkIn(
    userId: string,
    tripId: string,
    input: z.output<typeof CreateCheckInSchema>,
  ): Promise<CheckIn> {
    const trip = await this.loadMember(userId, tripId);
    this.assertOpenForSafety(trip);
    const row = await this.prisma.tripCheckIn.create({
      data: { tripId, userId, kind: input.kind, note: input.note || null },
      include: { user: { select: personSelect } },
    });
    // Arriving safely is the natural end of sharing.
    if (input.kind === 'ARRIVED_SAFELY') await this.endSessions({ tripId, userId }, 'stopped');
    return toCheckIn(row);
  }

  // ── SOS ───────────────────────────────────────────────────────────────────

  /**
   * Raises an SOS: the trip's members are notified (in the app, and by push when it is set up),
   * the member's emergency contacts are texted when SMS is available, and an audit event is
   * recorded. Voyago never contacts emergency services itself; the app shows the local number.
   */
  async raiseSos(
    userId: string,
    tripId: string,
    input: z.output<typeof RaiseSosSchema>,
    now = Date.now(),
  ): Promise<SosResult> {
    const trip = await this.loadMember(userId, tripId);
    this.assertOpenForSafety(trip, now);
    const recent = await this.prisma.sosAlert.count({
      where: { userId, createdAt: { gte: new Date(now - 60 * 60 * 1000) } },
    });
    if (recent >= SOS_PER_HOUR) {
      throw new HttpException(
        `You have raised ${SOS_PER_HOUR} SOS alerts in the last hour. Call ${EMERGENCY_NUMBER} if you are in danger.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const location = await this.sosLocation(tripId, userId, input.location, now);
    const [user, audience, contacts] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: personSelect }),
      this.audience(tripId, userId),
      this.prisma.emergencyContact.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    ]);

    let alert: AlertRow;
    try {
      alert = await this.prisma.$transaction(async (tx) => {
        const created = await tx.sosAlert.create({
          data: {
            tripId,
            userId,
            message: input.message || null,
            latitude: location?.latitude ?? null,
            longitude: location?.longitude ?? null,
            locationRecordedAt: location ? new Date(location.recordedAt) : null,
            membersNotified: audience.length,
          },
          include: alertInclude,
        });
        await this.notifications.notify(tx, audience, {
          type: 'SAFETY_ALERT',
          title: `SOS from ${user.displayName}`,
          body: `${input.message ? `"${input.message}" ` : ''}on ${trip.title}. Open the trip's safety page to see their last location.`,
          data: { tripId, screen: 'safety' },
        });
        await tx.auditLog.create({
          data: {
            actorId: userId,
            actorType: 'USER',
            action: 'sos.raise',
            entityType: 'trip',
            entityId: tripId,
            // Never the coordinates themselves.
            metadata: {
              alertId: created.id,
              hasLocation: location !== null,
              membersNotified: audience.length,
              contacts: contacts.length,
            },
          },
        });
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('You already have an active SOS on this trip');
      }
      throw error;
    }

    let contactsTexted = 0;
    if (this.sms.sosEnabled && contacts.length > 0) {
      const link = location
        ? `https://maps.google.com/?q=${location.latitude.toFixed(5)},${location.longitude.toFixed(5)}`
        : 'not available';
      const body =
        `Voyago SOS: ${user.displayName} asked for help during the trip "${trip.title}" ` +
        `(ref ${tripId.slice(0, 8)}). Last location: ${link}. Please contact them. If you think ` +
        `they are in danger, call ${EMERGENCY_NUMBER}. Voyago does not contact emergency services.`;
      const results = await Promise.allSettled(
        contacts.map((contact) =>
          this.sms.send(contact.phone, body, {
            template: 'sos',
            name: user.displayName,
            trip: trip.title,
            link,
          }),
        ),
      );
      contactsTexted = results.filter((r) => r.status === 'fulfilled').length;
      for (const failed of results.filter((r) => r.status === 'rejected')) {
        this.logger.warn(`SOS text failed: ${(failed.reason as Error).message}`);
      }
      await this.prisma.sosAlert.update({ where: { id: alert.id }, data: { contactsTexted } });
    }

    const result = toAlert(alert);
    this.realtime.emitToUsers(audience, 'sos:raised', result);
    return {
      alert: result,
      membersNotified: audience.length,
      contactsTexted,
      contactsTotal: contacts.length,
      smsAvailable: this.sms.sosEnabled,
      emergencyNumber: EMERGENCY_NUMBER,
    };
  }

  /**
   * The member says they are safe (or it was a false alarm), or the organiser closes it after
   * checking on them. The stored location is cleared, and members (and texted contacts) are told.
   */
  async resolveSos(
    userId: string,
    alertId: string,
    outcome: 'SAFE' | 'FALSE_ALARM',
  ): Promise<SosAlert> {
    const alert = await this.prisma.sosAlert.findUnique({
      where: { id: alertId },
      include: { ...alertInclude, trip: { select: { organiserId: true, title: true } } },
    });
    if (!alert) throw new NotFoundException('Alert not found');
    await this.loadMember(userId, alert.tripId).catch(() => {
      throw new NotFoundException('Alert not found');
    });
    const own = alert.userId === userId;
    if (!own && alert.trip.organiserId !== userId) {
      throw new HttpException(
        'Only the person who raised it or the organiser can close an SOS',
        HttpStatus.FORBIDDEN,
      );
    }
    if (outcome === 'FALSE_ALARM' && !own) {
      throw new HttpException(
        'Only the person who raised it can call it a false alarm',
        HttpStatus.FORBIDDEN,
      );
    }
    if (alert.status !== 'ACTIVE') throw new ConflictException('This SOS is already closed');
    const audience = await this.audience(alert.tripId, alert.userId);
    const resolver = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: personSelect,
    });
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.sosAlert.updateMany({
        where: { id: alertId, status: 'ACTIVE' },
        data: {
          status: outcome === 'SAFE' ? 'RESOLVED' : 'CANCELLED',
          resolvedAt: new Date(),
          resolvedById: userId,
          latitude: null,
          longitude: null,
          locationRecordedAt: null,
        },
      });
      if (changed.count === 0) throw new ConflictException('This SOS is already closed');
      const recipients = [...audience, ...(own ? [] : [alert.userId])].filter(
        (id) => id !== userId,
      );
      await this.notifications.notify(tx, recipients, {
        type: 'SAFETY_ALERT',
        title:
          outcome === 'SAFE'
            ? `${alert.user.displayName} is marked safe`
            : `${alert.user.displayName}'s SOS was a false alarm`,
        body: own ? null : `Closed by ${resolver.displayName} on ${alert.trip.title}.`,
        data: { tripId: alert.tripId, screen: 'safety' },
      });
      await tx.auditLog.create({
        data: {
          actorId: userId,
          actorType: 'USER',
          action: 'sos.resolve',
          entityType: 'trip',
          entityId: alert.tripId,
          metadata: { alertId, outcome, byRaiser: own },
        },
      });
      return tx.sosAlert.findUniqueOrThrow({ where: { id: alertId }, include: alertInclude });
    });
    // Contacts who were texted hear that it's over (where the provider sends free text; MSG91
    // only has the SOS template, which would read as a second alert).
    if (alert.contactsTexted > 0 && this.sms.sosEnabled && this.sms.freeText) {
      const contacts = await this.prisma.emergencyContact.findMany({
        where: { userId: alert.userId },
      });
      const body =
        outcome === 'SAFE'
          ? `Voyago: ${alert.user.displayName}'s SOS on "${alert.trip.title}" is closed. They are marked safe.`
          : `Voyago: ${alert.user.displayName}'s SOS on "${alert.trip.title}" was a false alarm.`;
      await Promise.allSettled(contacts.map((c) => this.sms.send(c.phone, body)));
    }
    const result = toAlert(updated);
    this.realtime.emitToUsers(
      [...audience, alert.userId].filter((id) => id !== userId),
      'sos:resolved',
      result,
    );
    return result;
  }

  // ── Emergency contacts ────────────────────────────────────────────────────

  async contacts(userId: string): Promise<EmergencyContact[]> {
    const rows = await this.prisma.emergencyContact.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toContact);
  }

  async addContact(
    userId: string,
    input: z.output<typeof CreateEmergencyContactSchema>,
  ): Promise<EmergencyContact> {
    const count = await this.prisma.emergencyContact.count({ where: { userId } });
    if (count >= MAX_EMERGENCY_CONTACTS) {
      throw new ConflictException(
        `You can have up to ${MAX_EMERGENCY_CONTACTS} emergency contacts`,
      );
    }
    try {
      const row = await this.prisma.emergencyContact.create({
        data: {
          userId,
          name: input.name,
          phone: input.phone,
          relationship: input.relationship || null,
        },
      });
      return toContact(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That number is already one of your contacts');
      }
      throw error;
    }
  }

  async removeContact(userId: string, id: string): Promise<void> {
    const deleted = await this.prisma.emergencyContact.deleteMany({ where: { id, userId } });
    if (deleted.count === 0) throw new NotFoundException('Contact not found');
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  /**
   * Ends sessions that ran out, whose trip is no longer live, whose member left or was removed,
   * or whose account is no longer active, and clears SOS locations older than a day. Runs on a
   * timer; reads and updates also check these things themselves.
   */
  async sweep(now = Date.now()): Promise<void> {
    await this.expireSessions({}, now);
    const active = await this.prisma.locationSession.findMany({
      where: { status: 'ACTIVE' },
      select: {
        tripId: true,
        userId: true,
        trip: { select: { status: true, departureAt: true, deletedAt: true } },
        user: { select: { status: true, deletedAt: true } },
      },
      take: 5000,
    });
    const memberships = await this.prisma.tripParticipant.findMany({
      where: {
        OR: active.map((s) => ({ tripId: s.tripId, userId: s.userId })),
        status: 'ACTIVE',
      },
      select: { tripId: true, userId: true },
    });
    const isMember = new Set(memberships.map((m) => `${m.tripId}:${m.userId}`));
    for (const session of active) {
      const where = { tripId: session.tripId, userId: session.userId };
      if (session.user.status !== 'ACTIVE' || session.user.deletedAt) {
        await this.endSessions(where, 'suspended');
      } else if (session.trip.deletedAt || !isTripLive(session.trip, now)) {
        await this.endSessions(where, 'trip_ended');
      } else if (!isMember.has(`${session.tripId}:${session.userId}`)) {
        await this.endSessions(where, 'left_trip');
      }
    }
    await this.prisma.sosAlert.updateMany({
      where: {
        latitude: { not: null },
        createdAt: { lt: new Date(now - AFTER_TRIP_WINDOW_MS) },
      },
      data: { latitude: null, longitude: null, locationRecordedAt: null },
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** The trip, if the user is one of its members (organiser included); 404 otherwise. */
  private async loadMember(userId: string, tripId: string): Promise<TripRow> {
    const [trip, participant] = await Promise.all([
      this.prisma.trip.findFirst({
        where: { id: tripId, deletedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          departureAt: true,
          completedAt: true,
          organiserId: true,
        },
      }),
      this.prisma.tripParticipant.findUnique({
        where: { tripId_userId: { tripId, userId } },
        select: { status: true },
      }),
    ]);
    // Completing a trip moves its members to COMPLETED; they keep check-ins and SOS for a day.
    const onTrip =
      participant?.status === 'ACTIVE' ||
      (participant?.status === 'COMPLETED' && trip?.status === 'COMPLETED');
    if (!trip || !onTrip) throw new NotFoundException('Trip not found');
    return trip;
  }

  private assertLive(trip: TripRow, now = Date.now()): void {
    if (!isTripLive(trip, now)) {
      throw new ConflictException(
        'Live location opens two hours before departure and closes when the trip ends',
      );
    }
  }

  /** Check-ins and SOS: the live window, and the day after the trip is completed. */
  private assertOpenForSafety(trip: TripRow, now = Date.now()): void {
    if (!isSafetyOpen(trip, now)) {
      throw new ConflictException(
        'Check-ins and SOS open two hours before departure and close a day after the trip',
      );
    }
  }

  /** Active members who may see this member: everyone on the trip but them and blocked people. */
  private async audience(tripId: string, userId: string): Promise<string[]> {
    const [members, hidden] = await Promise.all([
      this.prisma.tripParticipant.findMany({
        where: { tripId, status: { in: ['ACTIVE', 'COMPLETED'] }, userId: { not: userId } },
        select: { userId: true },
      }),
      blockedIds(this.prisma, userId),
    ]);
    return members.map((m) => m.userId).filter((id) => !hidden.includes(id));
  }

  private async sharers(tripId: string, hidden: string[]): Promise<Sharer[]> {
    const sessions = await this.prisma.locationSession.findMany({
      where: {
        tripId,
        status: 'ACTIVE',
        userId: { notIn: hidden },
        // Only people still on the trip.
        user: { participations: { some: { tripId, status: 'ACTIVE' } }, status: 'ACTIVE' },
      },
      include: { user: { select: personSelect } },
      orderBy: { startedAt: 'asc' },
    });
    if (sessions.length === 0) return [];
    const raw = await this.redis.client
      .mget(sessions.map((s) => pointKey(tripId, s.userId)))
      .catch(() => sessions.map(() => null));
    return sessions.map((session, index) => ({
      user: session.user satisfies SafetyPerson,
      expiresAt: session.expiresAt.toISOString(),
      location: parsePoint(raw[index] ?? null),
    }));
  }

  private async readPoint(tripId: string, userId: string): Promise<LocationPoint | null> {
    return parsePoint(await this.redis.client.get(pointKey(tripId, userId)));
  }

  /** The position sent with the SOS if recent, otherwise the last shared one, otherwise none. */
  private async sosLocation(
    tripId: string,
    userId: string,
    sent: z.output<typeof RaiseSosSchema>['location'],
    now: number,
  ): Promise<{ latitude: number; longitude: number; recordedAt: string } | null> {
    if (sent) {
      const age = now - new Date(sent.recordedAt).getTime();
      if (age <= SOS_LOCATION_MAX_AGE_MS && age >= -FUTURE_SKEW_MS) {
        return { ...sent, recordedAt: new Date(sent.recordedAt).toISOString() };
      }
    }
    const shared = await this.readPoint(tripId, userId).catch(() => null);
    return shared
      ? { latitude: shared.latitude, longitude: shared.longitude, recordedAt: shared.recordedAt }
      : null;
  }

  private async expireSessions(where: { tripId?: string }, now: number): Promise<void> {
    const due = await this.prisma.locationSession.findMany({
      where: { ...where, status: 'ACTIVE', expiresAt: { lte: new Date(now) } },
      select: { tripId: true, userId: true },
    });
    for (const session of due) await this.endSessions(session, 'expired');
  }

  /** Ends a member's active session on a trip, drops their point and tells the others. */
  async endSessions(where: { tripId: string; userId: string }, reason: EndReason): Promise<void> {
    const ended = await this.prisma.locationSession.updateMany({
      where: { ...where, status: 'ACTIVE' },
      data: {
        status: reason === 'expired' ? 'EXPIRED' : 'ENDED',
        endedAt: new Date(),
        endReason: reason,
      },
    });
    await this.redis.client.del(pointKey(where.tripId, where.userId)).catch(() => undefined);
    if (ended.count > 0) {
      const audience = await this.audience(where.tripId, where.userId);
      this.realtime.emitToUsers(audience, 'location:stopped', where);
    }
  }
}

function parsePoint(raw: string | null): LocationPoint | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LocationPoint;
  } catch {
    return null;
  }
}

function toCheckIn(row: {
  id: string;
  kind: CheckIn['kind'];
  note: string | null;
  createdAt: Date;
  user: SafetyPerson;
}): CheckIn {
  return {
    id: row.id,
    user: row.user,
    kind: row.kind,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

function toContact(row: {
  id: string;
  name: string;
  phone: string;
  relationship: string | null;
  createdAt: Date;
}): EmergencyContact {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    relationship: row.relationship,
    createdAt: row.createdAt.toISOString(),
  };
}
