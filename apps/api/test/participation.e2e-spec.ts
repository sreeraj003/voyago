import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  type AuthTokens,
  type CreateTripInput,
  JoinRequestSchema,
  NotificationSchema,
  ParticipantSchema,
  TripInvitationSchema,
  TripSchema,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { TripExpiryService } from '../src/trips/trip-expiry.service.js';
import { TripReminderService } from '../src/trips/trip-reminder.service.js';
import { bearer, login, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/** Join requests, participants and notifications against the real database. */
const prefix = `pj_${randomUUID().slice(0, 6)}`;
const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
const dataOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  schema.parse((res.body as { data: unknown }).data);
const NotificationPage = z.object({ data: z.array(NotificationSchema) });

const body = (overrides: Partial<CreateTripInput> = {}): CreateTripInput => ({
  mode: 'RIDE',
  activityType: 'MOTORCYCLE_RIDE',
  title: 'Ride to Savandurga',
  origin: { name: 'Kengeri', point: { latitude: 12.914321, longitude: 77.483456 } },
  destination: { name: 'Savandurga', point: { latitude: 12.9196, longitude: 77.2922 } },
  departureAt: inHours(72),
  maxParticipants: 6,
  visibility: 'PUBLIC',
  ...overrides,
});

const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hari'] as const;
type Name = (typeof NAMES)[number];

describe('participation (e2e)', () => {
  let app: INestApplication<App>;
  const tokens = {} as Record<Name, AuthTokens>;
  const ids = {} as Record<Name, string>;
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  const as = (name: Name) => ({ authorization: bearer(tokens[name]) });

  const createTrip = async (
    input: CreateTripInput = body(),
    publish = true,
    by: Name = 'alice',
  ) => {
    const res = await http().post('/api/v1/trips').set(as(by)).send(input).expect(201);
    const trip = dataOf(TripSchema, res);
    if (publish) await http().post(`/api/v1/trips/${trip.id}/publish`).set(as(by)).expect(200);
    return trip.id;
  };
  const ask = (name: Name, tripId: string, message?: string) =>
    http()
      .post(`/api/v1/trips/${tripId}/join-requests`)
      .set(as(name))
      .send(message ? { message } : {});
  const askOk = async (name: Name, tripId: string) =>
    dataOf(JoinRequestSchema, await ask(name, tripId).expect(201));
  const decide = (name: Name, requestId: string, verb: string, payload: object = {}) =>
    http().post(`/api/v1/join-requests/${requestId}/${verb}`).set(as(name)).send(payload);
  const getTrip = async (name: Name, tripId: string) =>
    dataOf(TripSchema, await http().get(`/api/v1/trips/${tripId}`).set(as(name)).expect(200));
  const notifications = async (name: Name) =>
    NotificationPage.parse(
      (await http().get('/api/v1/me/notifications?limit=50').set(as(name)).expect(200)).body,
    ).data;
  const activeCount = (tripId: string) =>
    prisma().tripParticipant.count({ where: { tripId, status: 'ACTIVE' } });

  beforeAll(async () => {
    app = await startAuthApp();
    for (const name of NAMES) {
      await registerAndLogin(app, {
        email: `${prefix}_${name}@example.test`,
        username: `${prefix}_${name}`,
      });
      tokens[name] = await login(app, `${prefix}_${name}@example.test`);
      ids[name] = (
        await prisma().user.findUniqueOrThrow({ where: { username: `${prefix}_${name}` } })
      ).id;
    }
  });

  afterAll(async () => {
    const userIds = Object.values(ids);
    await prisma().trip.deleteMany({ where: { organiserId: { in: userIds } } });
    await prisma().user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  describe('asking and deciding', () => {
    it('runs the approval flow and tells both sides', async () => {
      const tripId = await createTrip();
      const created = dataOf(
        JoinRequestSchema,
        await ask('bob', tripId, 'I ride a Himalayan, 5 years').expect(201),
      );
      expect(created).toMatchObject({ status: 'PENDING', message: 'I ride a Himalayan, 5 years' });
      expect(created.requester.username).toBe(`${prefix}_bob`);

      const before = await getTrip('bob', tripId);
      expect(before.viewer.joinRequest).toEqual({ id: created.id, status: 'PENDING' });
      expect(before.viewer.actions).not.toContain('join');
      expect(before.origin.approximate).toBe(true);
      expect((await getTrip('alice', tripId)).viewer.pendingRequestCount).toBe(1);

      const list = await http().get(`/api/v1/trips/${tripId}/join-requests`).set(as('alice'));
      expect(list.status).toBe(200);
      expect((list.body as { data: { id: string }[] }).data.map((r) => r.id)).toEqual([created.id]);
      expect((await notifications('alice'))[0]).toMatchObject({
        type: 'JOIN_REQUEST_RECEIVED',
        data: { tripId, joinRequestId: created.id },
      });

      const approved = dataOf(JoinRequestSchema, await decide('alice', created.id, 'approve'));
      expect(approved.status).toBe('APPROVED');
      const after = await getTrip('bob', tripId);
      expect(after.viewer).toMatchObject({ isParticipant: true, participantStatus: 'ACTIVE' });
      expect(after.viewer.actions).toContain('leave');
      expect(after.origin.approximate).toBe(false);
      expect(after.participantCount).toBe(2);
      expect((await notifications('bob'))[0]?.type).toBe('JOIN_REQUEST_APPROVED');

      // Decided requests stay decided.
      expect((await decide('alice', created.id, 'reject')).status).toBe(409);
    });

    it('lets the organiser decline with a reason, and the member ask again later', async () => {
      const tripId = await createTrip();
      const first = await askOk('carol', tripId);
      const rejected = await decide('alice', first.id, 'reject', {
        reason: 'Experienced riders only',
      });
      expect(dataOf(JoinRequestSchema, rejected)).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'Experienced riders only',
      });
      expect((await notifications('carol'))[0]).toMatchObject({
        type: 'JOIN_REQUEST_REJECTED',
        body: 'The organiser said: Experienced riders only',
      });
      await askOk('carol', tripId);
    });

    it('lets members withdraw their own pending request only', async () => {
      const tripId = await createTrip();
      const pending = await askOk('dave', tripId);
      expect((await decide('erin', pending.id, 'withdraw')).status).toBe(404);
      const withdrawn = await decide('dave', pending.id, 'withdraw').expect(200);
      expect(dataOf(JoinRequestSchema, withdrawn).status).toBe('WITHDRAWN');
      expect((await decide('dave', pending.id, 'withdraw')).status).toBe(409);
      expect((await decide('alice', pending.id, 'approve')).status).toBe(409);
      await askOk('dave', tripId);
    });

    it('joins open trips at once', async () => {
      const tripId = await createTrip(body({ approvalRequired: false }));
      const joined = await askOk('erin', tripId);
      expect(joined.status).toBe('APPROVED');
      expect((await getTrip('erin', tripId)).viewer.participantStatus).toBe('ACTIVE');
    });

    it('lists my own requests', async () => {
      const res = await http().get('/api/v1/me/join-requests').set(as('dave')).expect(200);
      const mine = z.object({ data: z.array(JoinRequestSchema) }).parse(res.body).data;
      expect(mine.length).toBeGreaterThanOrEqual(2);
      expect(new Set(mine.map((r) => r.requester.username))).toEqual(new Set([`${prefix}_dave`]));
    });
  });

  describe('who may do what', () => {
    it('refuses your own trip, duplicates, and deciding others’ or your own requests', async () => {
      const tripId = await createTrip();
      expect((await ask('alice', tripId)).status).toBe(409);
      const pending = await askOk('bob', tripId);
      const duplicate = await ask('bob', tripId);
      expect(duplicate.status).toBe(409);
      expect(JSON.stringify(duplicate.body)).toContain('already asked');
      expect((await decide('bob', pending.id, 'approve')).status).toBe(403);
      expect((await decide('carol', pending.id, 'approve')).status).toBe(403);
      expect(
        (await http().get(`/api/v1/trips/${tripId}/join-requests`).set(as('carol'))).status,
      ).toBe(403);
    });

    it('hides private trips, drafts and blocked organisers (404)', async () => {
      const privateTrip = await createTrip(body({ visibility: 'PRIVATE' }));
      expect((await ask('bob', privateTrip)).status).toBe(404);
      const draft = await createTrip(body(), false);
      expect((await ask('bob', draft)).status).toBe(404);
      const tripId = await createTrip();
      await prisma().userBlock.create({ data: { blockerId: ids.alice, blockedId: ids.hari } });
      try {
        expect((await ask('hari', tripId)).status).toBe(404);
      } finally {
        await prisma().userBlock.deleteMany({ where: { blockerId: ids.alice } });
      }
    });

    it('refuses cancelled, full and started trips', async () => {
      const cancelled = await createTrip();
      await http()
        .post(`/api/v1/trips/${cancelled}/cancel`)
        .set(as('alice'))
        .send({ reason: 'Rain' })
        .expect(200);
      const res = await ask('bob', cancelled);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('not taking new people');

      const small = await createTrip(body({ maxParticipants: 2, approvalRequired: false }));
      await askOk('bob', small);
      expect((await getTrip('alice', small)).status).toBe('FULL');
      const full = await ask('carol', small);
      expect(full.status).toBe(409);
      expect(JSON.stringify(full.body)).toContain('full');

      const soon = await createTrip(body({ departureAt: inHours(1) }));
      const pending = await askOk('bob', soon);
      await http().post(`/api/v1/trips/${soon}/start`).set(as('alice')).expect(200);
      expect((await ask('carol', soon)).status).toBe(409);
      const closed = await prisma().tripJoinRequest.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(closed.status).toBe('CANCELLED');
    });
  });

  describe('capacity', () => {
    it('never exceeds capacity when approvals happen at the same time', async () => {
      // Organiser plus one free place, five people waiting.
      const tripId = await createTrip(body({ maxParticipants: 2 }));
      const waiting = await Promise.all(
        (['bob', 'carol', 'dave', 'erin', 'frank'] as const).map((name) => askOk(name, tripId)),
      );
      const results = await Promise.all(waiting.map((r) => decide('alice', r.id, 'approve')));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409, 409, 409]);
      expect(await activeCount(tripId)).toBe(2);
      expect((await getTrip('alice', tripId)).status).toBe('FULL');
    });

    it('is enforced by the database too', async () => {
      const tripId = await createTrip(body({ maxParticipants: 2, approvalRequired: false }));
      await askOk('bob', tripId);
      await expect(
        prisma().tripParticipant.create({ data: { tripId, userId: ids.carol } }),
      ).rejects.toThrow();
      await expect(
        prisma().trip.update({ where: { id: tripId }, data: { maxParticipants: 1 } }),
      ).rejects.toThrow();
      expect(await activeCount(tripId)).toBe(2);
    });
  });

  describe('participants, leaving and removal', () => {
    it('shows the people on the trip to participants only', async () => {
      const tripId = await createTrip(body({ approvalRequired: false }));
      await askOk('bob', tripId);
      expect(
        (await http().get(`/api/v1/trips/${tripId}/participants`).set(as('carol'))).status,
      ).toBe(403);
      const res = await http()
        .get(`/api/v1/trips/${tripId}/participants`)
        .set(as('bob'))
        .expect(200);
      const people = z.array(ParticipantSchema).parse((res.body as { data: unknown }).data);
      expect(people.map((p) => [p.user.username, p.role])).toEqual([
        [`${prefix}_alice`, 'ORGANISER'],
        [`${prefix}_bob`, 'PARTICIPANT'],
      ]);
      // Public profile fields only.
      expect(JSON.stringify(res.body)).not.toContain('@example.test');
    });

    it('lets members leave, freeing the place, and come back', async () => {
      const tripId = await createTrip(body({ maxParticipants: 2, approvalRequired: false }));
      await askOk('bob', tripId);
      expect((await getTrip('alice', tripId)).status).toBe('FULL');
      await http().post(`/api/v1/trips/${tripId}/leave`).set(as('bob')).expect(204);
      expect((await getTrip('alice', tripId)).status).toBe('PUBLISHED');
      expect((await http().post(`/api/v1/trips/${tripId}/leave`).set(as('bob'))).status).toBe(409);
      expect((await http().post(`/api/v1/trips/${tripId}/leave`).set(as('alice'))).status).toBe(
        409,
      );
      const back = await askOk('bob', tripId);
      expect(back.status).toBe('APPROVED');
    });

    it('lets only the organiser remove people, audits it, and keeps them out', async () => {
      const tripId = await createTrip(body({ approvalRequired: false }));
      await askOk('bob', tripId);
      await askOk('carol', tripId);
      const remove = (by: Name, who: string, reason?: string) =>
        http()
          .post(`/api/v1/trips/${tripId}/participants/${who}/remove`)
          .set(as(by))
          .send(reason ? { reason } : {});
      expect((await remove('carol', ids.bob)).status).toBe(403);
      expect((await remove('alice', ids.alice)).status).toBe(409);
      await remove('alice', ids.bob, 'No-show at the last two rides').expect(204);
      expect((await remove('alice', ids.bob)).status).toBe(404);

      const row = await prisma().tripParticipant.findUniqueOrThrow({
        where: { tripId_userId: { tripId, userId: ids.bob } },
      });
      expect(row).toMatchObject({
        status: 'REMOVED',
        removedById: ids.alice,
        removalReason: 'No-show at the last two rides',
      });
      const audit = await prisma().auditLog.findFirst({
        where: { action: 'trip.participant_remove', entityId: tripId },
      });
      expect(audit?.metadata).toMatchObject({ removedUserId: ids.bob, byOrganiser: true });
      expect((await notifications('bob'))[0]).toMatchObject({
        type: 'PARTICIPANT_REMOVED',
        data: { tripId },
      });
      const again = await ask('bob', tripId);
      expect(again.status).toBe(403);
      expect((await getTrip('bob', tripId)).viewer.actions).not.toContain('join');
    });
  });

  describe('trip changes and notifications', () => {
    it('tells members about updates and cancellation, and closes pending requests', async () => {
      const tripId = await createTrip(body({ approvalRequired: false }));
      await askOk('bob', tripId);
      const otherTrip = await createTrip();
      const pending = await askOk('carol', otherTrip);

      await http()
        .patch(`/api/v1/trips/${tripId}`)
        .set(as('alice'))
        .send({ departureAt: inHours(80) })
        .expect(200);
      expect((await notifications('bob'))[0]).toMatchObject({
        type: 'TRIP_UPDATED',
        body: 'The organiser changed the departure time. Check the latest plan.',
      });
      // Description edits are not announced.
      const before = (await notifications('bob')).length;
      await http()
        .patch(`/api/v1/trips/${tripId}`)
        .set(as('alice'))
        .send({ description: 'Bring a rain jacket' })
        .expect(200);
      expect((await notifications('bob')).length).toBe(before);

      await http()
        .post(`/api/v1/trips/${otherTrip}/cancel`)
        .set(as('alice'))
        .send({ reason: 'Road closed' })
        .expect(200);
      const closed = await prisma().tripJoinRequest.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(closed.status).toBe('CANCELLED');
      expect((await notifications('carol'))[0]).toMatchObject({
        type: 'TRIP_CANCELLED',
        body: 'Reason: Road closed',
      });
    });

    it('marks members completed when the trip ends', async () => {
      const tripId = await createTrip(body({ departureAt: inHours(1), approvalRequired: false }));
      await askOk('gina', tripId);
      await http().post(`/api/v1/trips/${tripId}/start`).set(as('alice')).expect(200);
      await http().post(`/api/v1/trips/${tripId}/complete`).set(as('alice')).expect(200);
      const view = await getTrip('gina', tripId);
      expect(view.viewer).toMatchObject({ participantStatus: 'COMPLETED', isParticipant: true });
      expect(view.participantCount).toBe(2);
      expect(view.origin.approximate).toBe(false);
    });

    it('sends the reminder once, a day before departure', async () => {
      const tripId = await createTrip(body({ departureAt: inHours(20), approvalRequired: false }));
      await askOk('frank', tripId);
      const reminders = app.get(TripReminderService);
      expect(await reminders.sendDue()).toBeGreaterThanOrEqual(1);
      await reminders.sendDue();
      const sent = (await notifications('frank')).filter(
        (n) => n.type === 'TRIP_REMINDER' && n.data.tripId === tripId,
      );
      expect(sent).toHaveLength(1);
    });

    it('closes requests to trips that expired', async () => {
      const tripId = await createTrip();
      const pending = await askOk('hari', tripId);
      await prisma().trip.update({
        where: { id: tripId },
        data: { departureAt: new Date(Date.now() - 48 * HOUR) },
      });
      await app.get(TripExpiryService).expireOverdue();
      const closed = await prisma().tripJoinRequest.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(closed.status).toBe('CANCELLED');
    });

    it('reads and counts notifications for their owner only', async () => {
      const list = await notifications('bob');
      const first = list[0];
      if (!first) throw new Error('expected notifications');
      const count = async () =>
        z
          .object({ data: z.object({ count: z.number() }) })
          .parse((await http().get('/api/v1/me/notifications/unread-count').set(as('bob'))).body)
          .data.count;
      const unread = await count();
      expect(unread).toBeGreaterThan(0);
      await http().post(`/api/v1/me/notifications/${first.id}/read`).set(as('carol')).expect(404);
      await http().post(`/api/v1/me/notifications/${first.id}/read`).set(as('bob')).expect(204);
      expect(await count()).toBe(unread - 1);
      await http().post('/api/v1/me/notifications/read-all').set(as('bob')).expect(200);
      expect(await count()).toBe(0);
    });
  });

  describe('co-organisers', () => {
    const join = async (name: Name, tripId: string) => {
      const req = await askOk(name, tripId);
      await decide('alice', req.id, 'approve').expect(200);
    };
    const setRole = (by: Name, tripId: string, who: Name, role: string) =>
      http()
        .post(`/api/v1/trips/${tripId}/participants/${ids[who]}/role`)
        .set(as(by))
        .send({ role });

    it('lets the organiser appoint a co-organiser who then manages requests', async () => {
      const tripId = await createTrip();
      await join('bob', tripId);
      await join('carol', tripId);

      // Only the organiser appoints, and only people on the trip.
      await setRole('bob', tripId, 'carol', 'CO_ORGANISER').expect(403);
      await setRole('alice', tripId, 'dave', 'CO_ORGANISER').expect(404);
      await setRole('alice', tripId, 'alice', 'PARTICIPANT').expect(409);
      const people = z
        .object({ data: z.array(ParticipantSchema) })
        .parse((await setRole('alice', tripId, 'bob', 'CO_ORGANISER').expect(200)).body).data;
      expect(people.find((p) => p.user.id === ids.bob)?.role).toBe('CO_ORGANISER');

      const bobView = await getTrip('bob', tripId);
      expect(bobView.viewer).toMatchObject({ isCoOrganiser: true, isOrganiser: false });
      expect(bobView.viewer.actions).toContain('manage_people');
      expect(bobView.viewer.actions).not.toContain('edit');
      expect((await getTrip('carol', tripId)).viewer.actions).not.toContain('manage_people');

      const pending = await askOk('dave', tripId);
      expect((await getTrip('bob', tripId)).viewer.pendingRequestCount).toBe(1);
      await http().get(`/api/v1/trips/${tripId}/join-requests`).set(as('bob')).expect(200);
      await http().get(`/api/v1/trips/${tripId}/join-requests`).set(as('carol')).expect(403);
      await decide('carol', pending.id, 'approve').expect(403);
      await decide('bob', pending.id, 'approve').expect(200);
      const audit = await prisma().auditLog.findFirst({
        where: { actorId: ids.bob, action: 'trip.join_request_approve', entityId: tripId },
      });
      expect(audit).not.toBeNull();

      // Co-organisers remove participants, never each other or the organiser.
      await setRole('alice', tripId, 'carol', 'CO_ORGANISER').expect(200);
      const remove = (by: Name, who: Name) =>
        http()
          .post(`/api/v1/trips/${tripId}/participants/${ids[who]}/remove`)
          .set(as(by))
          .send({ reason: 'Testing removal' });
      await remove('bob', 'carol').expect(403);
      await remove('bob', 'alice').expect(409);
      await remove('bob', 'dave').expect(204);

      // Stepping down takes the powers away.
      await setRole('alice', tripId, 'bob', 'PARTICIPANT').expect(200);
      const after = await getTrip('bob', tripId);
      expect(after.viewer.isCoOrganiser).toBe(false);
      expect(after.viewer.actions).not.toContain('manage_people');
      await http().get(`/api/v1/trips/${tripId}/join-requests`).set(as('bob')).expect(403);
    });
  });

  describe('invitations', () => {
    const invite = (by: Name, tripId: string, who: string) =>
      http()
        .post(`/api/v1/trips/${tripId}/invitations`)
        .set(as(by))
        .send({ username: (NAMES as readonly string[]).includes(who) ? `${prefix}_${who}` : who });
    const InvitationPage = z.object({
      data: z.array(TripInvitationSchema),
    });
    const respond = (name: Name, id: string, verb: string) =>
      http().post(`/api/v1/trip-invitations/${id}/${verb}`).set(as(name));

    it('lets an invitee see and join a private trip', async () => {
      const tripId = await createTrip(body({ visibility: 'PRIVATE', title: 'Private ride' }));
      await http().get(`/api/v1/trips/${tripId}`).set(as('erin')).expect(404);
      await ask('erin', tripId).expect(404);

      await invite('erin', tripId, 'frank').expect(404); // can't see it, so can't invite
      await invite('alice', tripId, 'nobody_here_xyz').expect(404);
      await invite('alice', tripId, 'alice').expect(409);
      const created = dataOf(
        TripInvitationSchema,
        await invite('alice', tripId, 'erin').expect(201),
      );
      expect(created).toMatchObject({ status: 'PENDING', invitee: { id: ids.erin } });
      await invite('alice', tripId, 'erin').expect(409);

      const seen = await getTrip('erin', tripId);
      expect(seen.viewer.invitationId).toBe(created.id);
      expect(seen.viewer.actions).not.toContain('join');
      expect(seen.origin.approximate).toBe(true);
      // Private trips are joined by accepting, not asking.
      expect((await ask('erin', tripId).expect(409)).body).toMatchObject({
        message: 'You are invited: accept the invitation to join',
      });
      expect((await notifications('erin'))[0]).toMatchObject({
        type: 'TRIP_INVITE',
        data: { tripId, invitationId: created.id },
      });
      const mine = InvitationPage.parse(
        (await http().get('/api/v1/me/trip-invitations').set(as('erin')).expect(200)).body,
      ).data;
      expect(mine.map((i) => i.id)).toContain(created.id);
      const forTrip = InvitationPage.parse(
        (await http().get(`/api/v1/trips/${tripId}/invitations`).set(as('alice')).expect(200)).body,
      ).data;
      expect(forTrip.map((i) => i.id)).toEqual([created.id]);

      await respond('frank', created.id, 'accept').expect(404);
      const accepted = dataOf(TripInvitationSchema, await respond('erin', created.id, 'accept'));
      expect(accepted.status).toBe('ACCEPTED');
      const joined = await getTrip('erin', tripId);
      expect(joined.viewer).toMatchObject({ isParticipant: true, invitationId: null });
      expect(joined.origin.approximate).toBe(false);
      await respond('erin', created.id, 'decline').expect(409);
    });

    it('declines, revokes, and respects blocks and capacity', async () => {
      const tripId = await createTrip(body({ visibility: 'PRIVATE', maxParticipants: 2 }));
      const toFrank = dataOf(TripInvitationSchema, await invite('alice', tripId, 'frank'));
      const declined = dataOf(TripInvitationSchema, await respond('frank', toFrank.id, 'decline'));
      expect(declined.status).toBe('DECLINED');
      await http().get(`/api/v1/trips/${tripId}`).set(as('frank')).expect(404);

      const toGina = dataOf(TripInvitationSchema, await invite('alice', tripId, 'gina'));
      await respond('gina', toGina.id, 'revoke').expect(403);
      expect(dataOf(TripInvitationSchema, await respond('alice', toGina.id, 'revoke')).status).toBe(
        'REVOKED',
      );
      await http().get(`/api/v1/trips/${tripId}`).set(as('gina')).expect(404);

      // Blocked either way looks like an unknown username.
      await prisma().userBlock.create({ data: { blockerId: ids.hari, blockedId: ids.alice } });
      await invite('alice', tripId, 'hari').expect(404);
      await prisma().userBlock.deleteMany({ where: { blockerId: ids.hari } });

      // Two open invitations for the last place: the second accept finds the trip full.
      const a = dataOf(TripInvitationSchema, await invite('alice', tripId, 'hari'));
      const b = dataOf(TripInvitationSchema, await invite('alice', tripId, 'gina'));
      await respond('hari', a.id, 'accept').expect(200);
      expect((await respond('gina', b.id, 'accept')).status).toBe(409);
      expect(await activeCount(tripId)).toBe(2);
    });

    it('withdraws open invitations when the trip is cancelled', async () => {
      const tripId = await createTrip(body({ visibility: 'PRIVATE' }));
      const created = dataOf(TripInvitationSchema, await invite('alice', tripId, 'dave'));
      await http()
        .post(`/api/v1/trips/${tripId}/cancel`)
        .set(as('alice'))
        .send({ reason: 'Weather turned bad' })
        .expect(200);
      const row = await prisma().tripInvitation.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.status).toBe('REVOKED');
      expect((await notifications('dave'))[0]?.type).toBe('TRIP_CANCELLED');
    });
  });
});
