import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  AdminMeSchema,
  AdminOperatorDetailSchema,
  AdminOperatorPageSchema,
  AdminReportDetailSchema,
  AdminReportPageSchema,
  AdminTripDetailSchema,
  AdminUserDetailSchema,
  AdminUserPageSchema,
  AuditPageSchema,
  type AuthTokens,
  ChatMessageSchema,
  ConversationSchema,
  DashboardSchema,
  NotificationSchema,
  PERMISSIONS_BY_ROLE,
  type StaffRole,
  TripSchema,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { bearer, login, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/** Admin dashboard and moderation: role checks, audit, suspension, reports, operators. */
const prefix = `ad_${randomUUID().slice(0, 6)}`;
const dataOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  schema.parse((res.body as { data: unknown }).data);

const NAMES = ['admin', 'mod', 'support', 'ops', 'alice', 'bob', 'carol'] as const;
type Name = (typeof NAMES)[number];
const ROLES: Partial<Record<Name, StaffRole>> = {
  admin: 'SUPER_ADMIN',
  mod: 'MODERATOR',
  support: 'SUPPORT',
  ops: 'OPERATIONS',
};
const email = (name: Name) => `${prefix}_${name}@example.test`;

describe('admin and moderation (e2e)', () => {
  let app: INestApplication<App>;
  const tokens = {} as Record<Name, AuthTokens>;
  const ids = {} as Record<Name, string>;
  const operatorIds: string[] = [];
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  const as = (name: Name) => ({ authorization: bearer(tokens[name]) });
  const reason = { reason: 'Policy check during e2e test' };

  const createTrip = async (by: Name, title = 'Admin test ride') => {
    const res = await http()
      .post('/api/v1/trips')
      .set(as(by))
      .send({
        mode: 'RIDE',
        activityType: 'MOTORCYCLE_RIDE',
        title,
        origin: { name: 'Hebbal', point: { latitude: 13.0358, longitude: 77.597 } },
        destination: { name: 'Nandi Hills', point: { latitude: 13.3702, longitude: 77.6835 } },
        departureAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
        maxParticipants: 8,
        visibility: 'PUBLIC',
      })
      .expect(201);
    const trip = dataOf(TripSchema, res);
    await http().post(`/api/v1/trips/${trip.id}/publish`).set(as(by)).expect(200);
    return trip.id;
  };
  const report = async (by: Name, payload: object) =>
    dataOf(
      z.object({ id: z.uuid() }),
      await http().post('/api/v1/reports').set(as(by)).send(payload).expect(201),
    ).id;
  const auditFor = (entityId: string) =>
    prisma().auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    app = await startAuthApp();
    for (const name of NAMES) {
      await registerAndLogin(app, { email: email(name), username: `${prefix}_${name}` });
      const user = await prisma().user.update({
        where: { username: `${prefix}_${name}` },
        data: { role: ROLES[name] ?? 'USER' },
      });
      ids[name] = user.id;
      tokens[name] = await login(app, email(name));
    }
  });

  afterAll(async () => {
    const userIds = Object.values(ids);
    await prisma().commercialOperator.deleteMany({ where: { id: { in: operatorIds } } });
    await prisma().trip.deleteMany({ where: { organiserId: { in: userIds } } });
    await prisma().post.deleteMany({ where: { authorId: { in: userIds } } });
    await prisma().report.deleteMany({ where: { reporterId: { in: userIds } } });
    await prisma().user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  describe('role permissions', () => {
    it('refuses members and signed-out callers', async () => {
      await http().get('/api/v1/admin/me').expect(401);
      for (const path of ['me', 'dashboard', 'users', 'reports', 'trips', 'operators', 'audit']) {
        await http().get(`/api/v1/admin/${path}`).set(as('alice')).expect(403);
      }
    });

    it('tells each staff member their role and permissions', async () => {
      for (const name of ['admin', 'mod', 'support', 'ops'] as const) {
        const me = dataOf(
          AdminMeSchema,
          await http().get('/api/v1/admin/me').set(as(name)).expect(200),
        );
        expect(me).toMatchObject({ id: ids[name], role: ROLES[name] });
        expect(me.permissions).toEqual([...PERMISSIONS_BY_ROLE[ROLES[name]!]]);
      }
    });

    it('enforces the role matrix on the server', async () => {
      const someone = randomUUID();
      const checks: { method: 'get' | 'post'; path: string; body?: object; allowed: Name[] }[] = [
        { method: 'get', path: 'dashboard', allowed: ['admin', 'mod', 'support', 'ops'] },
        { method: 'get', path: 'users', allowed: ['admin', 'mod', 'support', 'ops'] },
        { method: 'get', path: 'trips', allowed: ['admin', 'mod', 'support', 'ops'] },
        { method: 'get', path: 'reports', allowed: ['admin', 'mod', 'support'] },
        { method: 'get', path: 'staff', allowed: ['admin', 'mod'] },
        { method: 'get', path: 'operators', allowed: ['admin', 'ops'] },
        { method: 'get', path: 'audit', allowed: ['admin'] },
        // Allowed roles get past the permission check and hit the missing record instead.
        {
          method: 'post',
          path: `users/${someone}/suspend`,
          body: reason,
          allowed: ['admin', 'mod'],
        },
        {
          method: 'post',
          path: `users/${someone}/role`,
          body: { role: 'SUPPORT', ...reason },
          allowed: ['admin'],
        },
        { method: 'post', path: `trips/${someone}/hide`, body: reason, allowed: ['admin', 'mod'] },
        {
          method: 'post',
          path: `reports/${someone}/resolve`,
          body: { outcome: 'DISMISSED', note: 'Nothing found here' },
          allowed: ['admin', 'mod'],
        },
        {
          method: 'post',
          path: `operators/${someone}/status`,
          body: { status: 'VERIFIED', ...reason },
          allowed: ['admin', 'ops'],
        },
        {
          method: 'post',
          path: `operators/${someone}/documents/${someone}/link`,
          allowed: ['admin', 'ops'],
        },
      ];
      for (const check of checks) {
        for (const name of ['admin', 'mod', 'support', 'ops'] as const) {
          const res = await http()
            [check.method](`/api/v1/admin/${check.path}`)
            .set(as(name))
            .send(check.body ?? {});
          const expected = check.allowed.includes(name)
            ? check.method === 'get'
              ? 200
              : 404
            : 403;
          expect({ path: check.path, name, status: res.status }).toEqual({
            path: check.path,
            name,
            status: expected,
          });
        }
      }
    });

    it('applies a role change on the next request', async () => {
      await http().get('/api/v1/admin/me').set(as('carol')).expect(403);
      await http()
        .post(`/api/v1/admin/users/${ids.carol}/role`)
        .set(as('mod'))
        .send({ role: 'SUPPORT', ...reason })
        .expect(403);
      const promoted = dataOf(
        AdminUserDetailSchema,
        await http()
          .post(`/api/v1/admin/users/${ids.carol}/role`)
          .set(as('admin'))
          .send({ role: 'SUPPORT', ...reason })
          .expect(200),
      );
      expect(promoted.role).toBe('SUPPORT');
      await http().get('/api/v1/admin/me').set(as('carol')).expect(200);
      await http()
        .post(`/api/v1/admin/users/${ids.carol}/role`)
        .set(as('admin'))
        .send({ role: 'USER', ...reason })
        .expect(200);
      await http().get('/api/v1/admin/me').set(as('carol')).expect(403);
      // Nobody changes their own role (so the last super admin cannot lock everyone out).
      await http()
        .post(`/api/v1/admin/users/${ids.admin}/role`)
        .set(as('admin'))
        .send({ role: 'USER', ...reason })
        .expect(403);
      const audit = await auditFor(ids.carol);
      expect(audit.filter((a) => a.action === 'user.role_change')).toEqual([
        expect.objectContaining({
          actorId: ids.admin,
          actorType: 'ADMIN',
          metadata: { from: 'USER', to: 'SUPPORT', reason: reason.reason, role: 'SUPER_ADMIN' },
        }),
        expect.objectContaining({
          metadata: { from: 'SUPPORT', to: 'USER', reason: reason.reason, role: 'SUPER_ADMIN' },
        }),
      ]);
    });
  });

  describe('dashboard', () => {
    it('reports platform metrics without booking numbers yet', async () => {
      const dashboard = dataOf(
        DashboardSchema,
        await http().get('/api/v1/admin/dashboard').set(as('support')).expect(200),
      );
      expect(dashboard.users.registeredLast7Days).toBeGreaterThanOrEqual(NAMES.length);
      expect(dashboard.bookings).toBeNull();
      expect(dashboard.daily).toHaveLength(14);
    });
  });

  describe('suspension and restoration', () => {
    it('suspends a member at once and restores them, auditing both', async () => {
      const found = AdminUserPageSchema.parse(
        (await http().get(`/api/v1/admin/users?q=${prefix}_alice`).set(as('support')).expect(200))
          .body,
      );
      expect(found.data.map((u) => u.id)).toEqual([ids.alice]);
      // Contact details are masked for staff.
      expect(found.data[0]!.maskedEmail).toBe(`a***@example.test`);
      expect(JSON.stringify(found)).not.toContain(email('alice'));

      await http()
        .post(`/api/v1/admin/users/${ids.alice}/suspend`)
        .set(as('mod'))
        .send({})
        .expect(400);
      const suspended = dataOf(
        AdminUserDetailSchema,
        await http()
          .post(`/api/v1/admin/users/${ids.alice}/suspend`)
          .set(as('mod'))
          .set('x-request-id', `${prefix}-suspend`)
          .send(reason)
          .expect(200),
      );
      expect(suspended).toMatchObject({
        status: 'SUSPENDED',
        suspension: { reason: reason.reason },
        actions: ['restore'],
      });
      // Signed out everywhere: the old token stops working and sign-in is refused.
      await http().get('/api/v1/me').set(as('alice')).expect(401);
      await http()
        .post('/api/v1/auth/login')
        .send({ email: email('alice'), password: 'correct horse battery' })
        .expect(403);
      await http()
        .post(`/api/v1/admin/users/${ids.alice}/suspend`)
        .set(as('mod'))
        .send(reason)
        .expect(409);

      const restored = dataOf(
        AdminUserDetailSchema,
        await http()
          .post(`/api/v1/admin/users/${ids.alice}/restore`)
          .set(as('mod'))
          .send({ reason: 'Appeal accepted after review' })
          .expect(200),
      );
      expect(restored.status).toBe('ACTIVE');
      expect(restored.history.map((h) => h.action)).toEqual(['user.restore', 'user.suspend']);
      tokens.alice = await login(app, email('alice'));

      const audit = await auditFor(ids.alice);
      expect(audit).toEqual([
        expect.objectContaining({
          actorId: ids.mod,
          actorType: 'ADMIN',
          action: 'user.suspend',
          entityType: 'user',
          requestId: `${prefix}-suspend`,
          metadata: { previousStatus: 'ACTIVE', reason: reason.reason, role: 'MODERATOR' },
        }),
        expect.objectContaining({ action: 'user.restore' }),
      ]);
    });

    it('keeps moderators away from staff accounts and their own', async () => {
      await http()
        .post(`/api/v1/admin/users/${ids.support}/suspend`)
        .set(as('mod'))
        .send(reason)
        .expect(403);
      await http()
        .post(`/api/v1/admin/users/${ids.mod}/suspend`)
        .set(as('mod'))
        .send(reason)
        .expect(403);
      await http()
        .post(`/api/v1/admin/users/${ids.alice}/suspend`)
        .set(as('support'))
        .send(reason)
        .expect(403);
      expect(await auditFor(ids.support)).toEqual([]);
    });
  });

  describe('report lifecycle and content moderation', () => {
    let tripId: string;
    let tripReport: string;
    let messageId: string;

    beforeAll(async () => {
      tripId = await createTrip('alice');
      await prisma().tripParticipant.create({ data: { tripId, userId: ids.bob } });
      const chat = dataOf(
        ConversationSchema,
        await http().post(`/api/v1/trips/${tripId}/chat`).set(as('alice')).expect(200),
      );
      messageId = dataOf(
        ChatMessageSchema,
        await http()
          .post(`/api/v1/conversations/${chat.id}/messages`)
          .set(as('alice'))
          .send({ clientId: randomUUID(), body: 'Let us race at 140 on the highway' })
          .expect(201),
      ).id;
    });

    it('files reports with a starting severity, including chat messages', async () => {
      tripReport = await report('bob', {
        targetType: 'TRIP',
        targetId: tripId,
        reason: 'UNSAFE_BEHAVIOUR',
        details: 'Plans to speed',
      });
      await report('bob', {
        targetType: 'MESSAGE',
        targetId: messageId,
        reason: 'UNSAFE_BEHAVIOUR',
      });
      // Only people in the chat can report its messages.
      await http()
        .post('/api/v1/reports')
        .set(as('carol'))
        .send({ targetType: 'MESSAGE', targetId: messageId, reason: 'SPAM' })
        .expect(404);
      const queue = AdminReportPageSchema.parse(
        (
          await http()
            .get('/api/v1/admin/reports?severity=HIGH&limit=100')
            .set(as('support'))
            .expect(200)
        ).body,
      );
      const mine = queue.data.filter((r) => r.reporter?.id === ids.bob);
      expect(mine.map((r) => [r.targetType, r.severity, r.status])).toEqual([
        ['TRIP', 'HIGH', 'OPEN'],
        ['MESSAGE', 'HIGH', 'OPEN'],
      ]);
      expect(mine[0]).toMatchObject({
        targetLabel: 'Admin test ride',
        reportedUser: { id: ids.alice },
      });
    });

    it('shows moderators the reported content and what they can do', async () => {
      const detail = dataOf(
        AdminReportDetailSchema,
        await http().get(`/api/v1/admin/reports/${tripReport}`).set(as('mod')).expect(200),
      );
      expect(detail).toMatchObject({
        details: 'Plans to speed',
        target: { exists: true, status: 'PUBLISHED', context: 'From Hebbal to Nandi Hills' },
      });
      expect(detail.actions).toEqual(
        expect.arrayContaining([
          'assign',
          'triage',
          'resolve',
          'suspend_user',
          'hide_trip',
          'cancel_trip',
        ]),
      );
      const supportView = dataOf(
        AdminReportDetailSchema,
        await http().get(`/api/v1/admin/reports/${tripReport}`).set(as('support')).expect(200),
      );
      expect(supportView.actions).toEqual([]);
    });

    it('assigns, triages, resolves and reopens, auditing every step', async () => {
      const base = `/api/v1/admin/reports/${tripReport}`;
      await http()
        .post(`${base}/assign`)
        .set(as('support'))
        .send({ assigneeId: ids.support })
        .expect(403);
      await http()
        .post(`${base}/assign`)
        .set(as('mod'))
        .send({ assigneeId: ids.support })
        .expect(400);
      const assigned = dataOf(
        AdminReportDetailSchema,
        await http()
          .post(`${base}/assign`)
          .set(as('mod'))
          .send({ assigneeId: ids.mod })
          .expect(200),
      );
      expect(assigned).toMatchObject({ status: 'IN_REVIEW', assignedTo: { id: ids.mod } });

      const triaged = dataOf(
        AdminReportDetailSchema,
        await http()
          .patch(base)
          .set(as('mod'))
          .send({ severity: 'CRITICAL', evidenceRefs: [`message:${messageId}`] })
          .expect(200),
      );
      expect(triaged).toMatchObject({
        severity: 'CRITICAL',
        evidenceRefs: [`message:${messageId}`],
      });

      await http().post(`${base}/resolve`).set(as('mod')).send({ outcome: 'ACTIONED' }).expect(400);
      const resolved = dataOf(
        AdminReportDetailSchema,
        await http()
          .post(`${base}/resolve`)
          .set(as('mod'))
          .send({ outcome: 'ACTIONED', note: 'Trip hidden and organiser warned' })
          .expect(200),
      );
      expect(resolved).toMatchObject({
        status: 'ACTIONED',
        resolutionNote: 'Trip hidden and organiser warned',
      });
      expect(resolved.actions).toContain('reopen');
      expect(resolved.actions).not.toContain('resolve');
      expect(resolved.resolvedAt).not.toBeNull();
      await http().patch(base).set(as('mod')).send({ severity: 'LOW' }).expect(409);

      // The reporter hears back, without details about the other person.
      const notes = z
        .object({ data: z.array(NotificationSchema) })
        .parse((await http().get('/api/v1/me/notifications').set(as('bob')).expect(200)).body).data;
      expect(notes.find((n) => n.type === 'SYSTEM')).toMatchObject({
        title: 'We reviewed your report',
      });

      await http().post(`${base}/reopen`).set(as('mod')).send({ reason: 'x' }).expect(400);
      const reopened = dataOf(
        AdminReportDetailSchema,
        await http().post(`${base}/reopen`).set(as('mod')).send(reason).expect(200),
      );
      expect(reopened).toMatchObject({
        status: 'IN_REVIEW',
        resolvedAt: null,
        resolutionNote: null,
      });
      expect(reopened.history.map((h) => h.action)).toEqual([
        'report.reopen',
        'report.resolve',
        'report.triage',
        'report.assign',
      ]);
      expect(reopened.history.every((h) => h.actor?.id === ids.mod)).toBe(true);
    });

    it('hides a trip from everyone but its people, and shows it again', async () => {
      await http()
        .post(`/api/v1/admin/trips/${tripId}/hide`)
        .set(as('support'))
        .send(reason)
        .expect(403);
      const hidden = dataOf(
        AdminTripDetailSchema,
        await http()
          .post(`/api/v1/admin/trips/${tripId}/hide`)
          .set(as('mod'))
          .send(reason)
          .expect(200),
      );
      expect(hidden).toMatchObject({
        hidden: true,
        hiddenReason: reason.reason,
        actions: ['unhide', 'cancel'],
      });
      await http()
        .post(`/api/v1/admin/trips/${tripId}/hide`)
        .set(as('mod'))
        .send(reason)
        .expect(409);

      await http().get(`/api/v1/trips/${tripId}`).set(as('carol')).expect(404);
      await http().get(`/api/v1/trips/${tripId}`).set(as('bob')).expect(200);
      const forOrganiser = dataOf(
        TripSchema,
        await http().get(`/api/v1/trips/${tripId}`).set(as('alice')).expect(200),
      );
      expect(forOrganiser.hiddenReason).toBe(reason.reason);

      await http()
        .post(`/api/v1/admin/trips/${tripId}/unhide`)
        .set(as('mod'))
        .send({ reason: 'Organiser updated the plan' })
        .expect(200);
      const visible = dataOf(
        TripSchema,
        await http().get(`/api/v1/trips/${tripId}`).set(as('carol')).expect(200),
      );
      expect(visible.hiddenReason).toBeNull();
      expect((await auditFor(tripId)).map((a) => a.action)).toEqual(['trip.hide', 'trip.unhide']);
    });

    it('removes a reported chat message for everyone', async () => {
      await http()
        .post(`/api/v1/admin/messages/${messageId}/remove`)
        .set(as('mod'))
        .send(reason)
        .expect(204);
      const row = await prisma().message.findUniqueOrThrow({ where: { id: messageId } });
      expect(row).toMatchObject({ body: null });
      expect(row.deletedAt).not.toBeNull();
      await http()
        .post(`/api/v1/admin/messages/${messageId}/remove`)
        .set(as('mod'))
        .send(reason)
        .expect(409);
      expect((await auditFor(messageId)).map((a) => a.action)).toEqual(['message.remove']);
    });

    it('cancels an unsafe trip through the normal cancellation', async () => {
      const other = await createTrip('alice', 'Admin cancel ride');
      const cancelled = dataOf(
        AdminTripDetailSchema,
        await http()
          .post(`/api/v1/admin/trips/${other}/cancel`)
          .set(as('mod'))
          .send(reason)
          .expect(200),
      );
      expect(cancelled).toMatchObject({ status: 'CANCELLED', cancellationReason: reason.reason });
      expect((await auditFor(other)).map((a) => a.action)).toEqual(['trip.moderate_cancel']);
    });
  });

  describe('operator verification', () => {
    let operatorId: string;
    let docs: string[];

    beforeAll(async () => {
      const operator = await prisma().commercialOperator.create({
        data: {
          ownerUserId: ids.carol,
          slug: `${prefix}-tours`,
          legalName: 'E2E Test Tours (not a real business)',
          displayName: 'E2E Tours',
          gstin: null,
          submittedAt: new Date(),
          documents: {
            create: [
              {
                kind: 'BUSINESS_REGISTRATION',
                storageKey: `voyago-test/operator-docs/${ids.carol}/${randomUUID()}`,
                format: 'pdf',
                fileName: 'registration.pdf',
              },
              {
                kind: 'INSURANCE',
                storageKey: `voyago-test/operator-docs/${ids.carol}/${randomUUID()}`,
                format: 'jpg',
                fileName: 'insurance.jpg',
              },
            ],
          },
        },
        include: { documents: { orderBy: { kind: 'asc' } } },
      });
      operatorId = operator.id;
      operatorIds.push(operator.id);
      docs = operator.documents.map((d) => d.id);
    });

    it('lists the verification queue for operations staff only', async () => {
      const page = AdminOperatorPageSchema.parse(
        (
          await http()
            .get('/api/v1/admin/operators?status=PENDING&limit=100')
            .set(as('ops'))
            .expect(200)
        ).body,
      );
      expect(page.data.find((o) => o.id === operatorId)).toMatchObject({
        documentCount: 2,
        pendingDocumentCount: 2,
      });
      await http().get(`/api/v1/admin/operators/${operatorId}`).set(as('mod')).expect(403);
      await http().get(`/api/v1/admin/operators/${operatorId}`).set(as('support')).expect(403);
    });

    it('never verifies until a person has reviewed the documents', async () => {
      const base = `/api/v1/admin/operators/${operatorId}`;
      const verify = { status: 'VERIFIED', reason: 'Documents match the business' };
      await http().post(`${base}/status`).set(as('ops')).send(verify).expect(409);
      await http()
        .post(`${base}/documents/${docs[0]}/review`)
        .set(as('ops'))
        .send({ status: 'REJECTED', note: 'Blurry scan' })
        .expect(200);
      await http()
        .post(`${base}/documents/${docs[1]}/review`)
        .set(as('ops'))
        .send({ status: 'REJECTED', note: 'Expired' })
        .expect(200);
      // Every document reviewed, but none accepted.
      await http().post(`${base}/status`).set(as('ops')).send(verify).expect(409);
      await http()
        .post(`${base}/documents/${docs[0]}/review`)
        .set(as('ops'))
        .send({ status: 'ACCEPTED', note: 'Clear copy received' })
        .expect(200);
      const verified = dataOf(
        AdminOperatorDetailSchema,
        await http().post(`${base}/status`).set(as('ops')).send(verify).expect(200),
      );
      expect(verified).toMatchObject({
        verificationStatus: 'VERIFIED',
        verifiedBy: { id: ids.ops },
        verificationNote: verify.reason,
      });
      expect(verified.documents.map((d) => [d.status, d.reviewedBy?.id])).toEqual([
        ['ACCEPTED', ids.ops],
        ['REJECTED', ids.ops],
      ]);
      const audit = AuditPageSchema.parse(
        (
          await http()
            .get(`/api/v1/admin/audit?entityType=operator&entityId=${operatorId}`)
            .set(as('admin'))
            .expect(200)
        ).body,
      );
      expect(audit.data.map((a) => a.action)).toEqual([
        'operator.verified',
        'operator.document_review',
        'operator.document_review',
        'operator.document_review',
      ]);
      expect(audit.data[0]).toMatchObject({ actor: { id: ids.ops }, reason: verify.reason });
    });

    it('restricts documents and refuses reviewing your own operator', async () => {
      const link = `/api/v1/admin/operators/${operatorId}/documents/${docs[0]}/link`;
      await http().post(link).set(as('support')).expect(403);
      await http().post(link).set(as('mod')).expect(403);
      // Allowed, but no document storage is configured in tests: no link, nothing pretended.
      await http().post(link).set(as('ops')).expect(503);

      const own = await prisma().commercialOperator.create({
        data: {
          ownerUserId: ids.ops,
          slug: `${prefix}-own`,
          legalName: 'E2E Own Operator',
          displayName: 'Own',
        },
      });
      operatorIds.push(own.id);
      await http()
        .post(`/api/v1/admin/operators/${own.id}/status`)
        .set(as('ops'))
        .send({ status: 'REJECTED', reason: 'Testing own operator review' })
        .expect(403);
    });
  });
});
