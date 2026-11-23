import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  AdminOperatorDetailSchema,
  type AuthTokens,
  MyOperatorSchema,
  NotificationSchema,
  OperatorDashboardSchema,
  OwnPackageSchema,
  PackageCardSchema,
  PackageDetailSchema,
  PackageQuestionSchema,
  PublicOperatorSchema,
  type StaffRole,
  UploadSignatureSchema,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { CloudinaryService } from '../src/integrations/cloudinary.service.js';
import { bearer, login, registerAndLogin, startAuthApp } from './support/auth-helpers.js';
import { bookingFields } from './support/booking-fields.js';

/**
 * Commercial operators and packages: onboarding, the verification gate on publishing, price and
 * capacity validation, the terms shown publicly, questions, and staff moderation.
 */
const prefix = `co_${randomUUID().slice(0, 6)}`;
const dataOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  schema.parse((res.body as { data: unknown }).data);
const listOf = <T>(schema: z.ZodType<T>, res: { body: unknown }): T[] =>
  z.array(schema).parse((res.body as { data: unknown }).data);

const NAMES = ['owner', 'other', 'member', 'admin', 'mod', 'ops'] as const;
type Name = (typeof NAMES)[number];
const ROLES: Partial<Record<Name, StaffRole>> = {
  admin: 'SUPER_ADMIN',
  mod: 'MODERATOR',
  ops: 'OPERATIONS',
};
const email = (name: Name) => `${prefix}_${name}@example.test`;
const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
/** 06:00 India time, `days` from today, plus `hours`. */
const istDay = (days: number, hours = 0) => {
  const d = new Date(Date.now() + days * 24 * HOUR);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 30) + hours * HOUR,
  ).toISOString();
};

const profile = {
  displayName: `${prefix} Ghats Treks`,
  legalName: 'Ghats Treks Private Limited',
  category: 'TREKKING',
  businessEmail: 'hello@ghats-treks.example',
  address: {
    line1: '12 MG Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560001',
  },
  acceptTerms: true,
};

const packageInput = () => ({
  mode: 'TRAVEL',
  activityType: 'TREK',
  title: 'Kudremukh weekend trek',
  description: 'Two days on the Kudremukh trail with a certified guide.',
  destination: { name: 'Kudremukh', point: { latitude: 13.1317, longitude: 75.2654 } },
  meetingPoint: { name: 'Mullodi village', point: { latitude: 13.123456, longitude: 75.271234 } },
  startsAt: istDay(10),
  endsAt: istDay(10, 36),
  pricePaise: 349_900,
  capacity: 12,
  inclusions: ['Forest entry permit', 'Guide', 'Two meals'],
  exclusions: ['Travel to the base village'],
  cancellationPolicy: 'Full refund up to 7 days before the start; 50% up to 48 hours before.',
  refundTiers: [
    { hoursBefore: 168, refundPercent: 100 },
    { hoursBefore: 48, refundPercent: 50 },
  ],
});

describe('commercial operators and packages (e2e)', () => {
  let app: INestApplication<App>;
  const tokens = {} as Record<Name, AuthTokens>;
  const ids = {} as Record<Name, string>;
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  const as = (name: Name) => ({ authorization: bearer(tokens[name]) });
  /** Uploads Cloudinary "has": public id → stored format. */
  const uploads = new Map<string, string>();
  let operatorId = '';
  let packageId = '';

  const docId = (name: Name) => `voyago/operator-docs/${ids[name]}/${randomUUID()}`;
  const photoId = (name: Name) => `voyago/package-photos/${ids[name]}/${randomUUID()}`;

  beforeAll(async () => {
    app = await startAuthApp({
      CLOUDINARY_CLOUD_NAME: 'e2e',
      CLOUDINARY_API_KEY: 'e2e-key',
      CLOUDINARY_API_SECRET: 'e2e-secret',
      CLOUDINARY_FOLDER: 'voyago',
    });
    // A stand-in for Cloudinary's Admin API, answering for the uploads listed above.
    Object.assign(app.get(CloudinaryService), {
      fetchImpl: (url: string) => {
        const id = /\/resources\/image\/(?:upload|authenticated)\/(.+)$/.exec(url)?.[1] ?? '';
        const format = uploads.get(id);
        return Promise.resolve(
          format
            ? new Response(JSON.stringify({ bytes: 120_000, format }), { status: 200 })
            : new Response('{}', { status: 404 }),
        );
      },
    });
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
    const operators = await prisma().commercialOperator.findMany({
      where: { ownerUserId: { in: userIds } },
      select: { id: true },
    });
    const operatorIds = operators.map((o) => o.id);
    await prisma().booking.deleteMany({ where: { package: { operatorId: { in: operatorIds } } } });
    await prisma().report.deleteMany({ where: { reporterId: { in: userIds } } });
    await prisma().commercialPackage.deleteMany({ where: { operatorId: { in: operatorIds } } });
    await prisma().commercialOperator.deleteMany({ where: { id: { in: operatorIds } } });
    await prisma().user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  describe('onboarding', () => {
    it('needs the terms, a contact, a valid PIN code and GSTIN', async () => {
      await http().get('/api/v1/me/operator').set(as('owner')).expect(404);
      const bad = [
        { ...profile, acceptTerms: false },
        { ...profile, businessEmail: undefined },
        { ...profile, address: { ...profile.address, postalCode: '56001' } },
        { ...profile, gstin: '29ABCDE1234F1Z' },
        { ...profile, website: 'http://ghats.example' },
        { ...profile, category: 'RIDE_HAILING' },
      ];
      for (const body of bad) {
        await http().post('/api/v1/me/operator').set(as('owner')).send(body).expect(400);
      }
    });

    it('creates one business per member and says what is missing', async () => {
      const mine = dataOf(
        MyOperatorSchema,
        await http()
          .post('/api/v1/me/operator')
          .set(as('owner'))
          .send({ ...profile, gstin: '29abcde1234f1z5' })
          .expect(201),
      );
      operatorId = mine.id;
      expect(mine).toMatchObject({
        verificationStatus: 'PENDING',
        gstin: '29ABCDE1234F1Z5',
        termsVersion: '2026-11',
        missing: ['At least one verification document'],
        inReview: false,
        canSubmit: false,
        canPublish: false,
      });
      expect(mine.slug).toMatch(/ghats-treks$/);
      expect(mine.termsAcceptedAt).not.toBeNull();
      await http().post('/api/v1/me/operator').set(as('owner')).send(profile).expect(409);
      // Someone else can't reuse the GSTIN.
      await http()
        .post('/api/v1/me/operator')
        .set(as('other'))
        .send({ ...profile, displayName: `${prefix} Copy`, gstin: '29ABCDE1234F1Z5' })
        .expect(409);
      const audit = await prisma().auditLog.findMany({ where: { entityId: operatorId } });
      expect(audit.map((a) => a.action)).toEqual(['operator.create']);
    });

    it('accepts only the owner’s real uploads as documents', async () => {
      const sig = dataOf(
        UploadSignatureSchema,
        await http().post('/api/v1/me/operator/documents/signature').set(as('owner')).expect(201),
      );
      expect(sig.imageId.startsWith(`voyago/operator-docs/${ids.owner}/`)).toBe(true);
      expect(sig.fields).toMatchObject({
        type: 'authenticated',
        allowed_formats: 'pdf,jpg,jpeg,png',
      });

      const add = (documentId: string, expected: number) =>
        http()
          .post('/api/v1/me/operator/documents')
          .set(as('owner'))
          .send({ kind: 'BUSINESS_REGISTRATION', documentId, fileName: 'registration.pdf' })
          .expect(expected);
      // Not uploaded, someone else's folder, and a file type that isn't allowed.
      await add(sig.imageId, 400);
      const theirs = docId('other');
      uploads.set(theirs, 'pdf');
      await add(theirs, 400);
      const gif = docId('owner');
      uploads.set(gif, 'gif');
      await add(gif, 400);

      uploads.set(sig.imageId, 'pdf');
      const mine = dataOf(MyOperatorSchema, await add(sig.imageId, 201));
      expect(mine.documents).toMatchObject([
        { kind: 'BUSINESS_REGISTRATION', fileName: 'registration.pdf', status: 'PENDING' },
      ]);
      expect(mine).toMatchObject({ missing: [], canSubmit: true });
      await add(sig.imageId, 409);
    });

    it('submits for review once', async () => {
      const mine = dataOf(
        MyOperatorSchema,
        await http().post('/api/v1/me/operator/submit').set(as('owner')).expect(200),
      );
      expect(mine).toMatchObject({ inReview: true, canSubmit: false });
      await http().post('/api/v1/me/operator/submit').set(as('owner')).expect(409);
      // A profile with nothing on file can't be submitted.
      await http()
        .post('/api/v1/me/operator')
        .set(as('other'))
        .send({ ...profile, displayName: `${prefix} Other Co` })
        .expect(201);
      await http().post('/api/v1/me/operator/submit').set(as('other')).expect(409);
    });
  });

  describe('packages before verification', () => {
    it('validates price, capacity, dates and terms', async () => {
      const create = (patch: object) =>
        http()
          .post('/api/v1/me/operator/packages')
          .set(as('owner'))
          .send({ ...packageInput(), ...patch });
      const invalid: object[] = [
        { pricePaise: 0 },
        { pricePaise: 99 },
        { pricePaise: 3499.5 },
        { pricePaise: 100_000_001 },
        { capacity: 0 },
        { capacity: 201 },
        { capacity: 2.5 },
        { currency: 'USD' },
        { endsAt: at(24 * 9) },
        { startsAt: at(-1) },
        { endsAt: at(24 * 80) },
        { mode: 'RIDE' },
        { inclusions: [] },
        { cancellationPolicy: 'No refunds.' },
        {
          refundTiers: [
            { hoursBefore: 48, refundPercent: 50 },
            { hoursBefore: 168, refundPercent: 20 },
          ],
        },
        { refundTiers: [{ hoursBefore: 48, refundPercent: 150 }] },
        { photoIds: ['https://example.com/photo.jpg'] },
      ];
      for (const patch of invalid) {
        const res = await create(patch);
        expect([res.status, patch]).toEqual([400, patch]);
      }
      // Photos must be the operator's own uploads.
      await create({ photoIds: [photoId('owner')] }).expect(400);
    });

    it('lets an unverified business draft but not publish', async () => {
      const photo = photoId('owner');
      uploads.set(photo, 'jpg');
      const draft = dataOf(
        OwnPackageSchema,
        await http()
          .post('/api/v1/me/operator/packages')
          .set(as('owner'))
          .send({ ...packageInput(), photoIds: [photo] })
          .expect(201),
      );
      packageId = draft.id;
      expect(draft).toMatchObject({
        status: 'DRAFT',
        commercial: true,
        pricePaise: 349_900,
        currency: 'INR',
        capacity: 12,
        seatsLeft: 12,
        durationDays: 2,
        publishIssues: ['Your business must be verified first'],
        photoIds: [photo],
        meetingPoint: {
          name: 'Mullodi village',
          point: { latitude: 13.123456, longitude: 75.271234 },
          approximate: false,
        },
        operator: { verified: false },
      });
      expect(draft.actions).toContain('edit');

      await http()
        .post(`/api/v1/me/operator/packages/${packageId}/publish`)
        .set(as('owner'))
        .expect(409);
      // The database refuses it too.
      await expect(
        prisma().commercialPackage.update({
          where: { id: packageId },
          data: { status: 'PUBLISHED', publishedAt: new Date() },
        }),
      ).rejects.toThrow(/VERIFIED operators/);

      // Not visible or listed to anyone else.
      await http().get(`/api/v1/packages/${packageId}`).set(as('member')).expect(404);
      const listed = await http().get('/api/v1/packages?limit=100').set(as('member')).expect(200);
      expect(listOf(PackageCardSchema, listed).map((p) => p.id)).not.toContain(packageId);
      await http().get(`/api/v1/operators/${draft.operator.slug}`).set(as('member')).expect(404);
      // Nor to another operator through the owner's routes.
      await http().get(`/api/v1/me/operator/packages/${packageId}`).set(as('other')).expect(404);
    });
  });

  describe('after verification', () => {
    it('verifies through staff review, then publishes', async () => {
      const detail = dataOf(
        AdminOperatorDetailSchema,
        await http().get(`/api/v1/admin/operators/${operatorId}`).set(as('ops')).expect(200),
      );
      await http()
        .post(`/api/v1/admin/operators/${operatorId}/documents/${detail.documents[0]!.id}/review`)
        .set(as('ops'))
        .send({ status: 'ACCEPTED', note: 'Registration matches' })
        .expect(200);
      await http()
        .post(`/api/v1/admin/operators/${operatorId}/status`)
        .set(as('ops'))
        .send({ status: 'VERIFIED', reason: 'Documents match the business' })
        .expect(200);
      const notes = await http().get('/api/v1/me/notifications').set(as('owner')).expect(200);
      expect(listOf(NotificationSchema, notes)[0]?.title).toMatch(/verified/i);

      const published = dataOf(
        OwnPackageSchema,
        await http()
          .post(`/api/v1/me/operator/packages/${packageId}/publish`)
          .set(as('owner'))
          .expect(200),
      );
      expect(published).toMatchObject({ status: 'PUBLISHED', operator: { verified: true } });
      expect(published.publishedAt).not.toBeNull();
      expect(published.actions).toEqual(expect.arrayContaining(['unpublish', 'archive']));
      expect(published.actions).not.toContain('edit');
    });

    it('shows the commercial label and every required term publicly', async () => {
      const list = await http()
        .get(`/api/v1/packages?q=Kudremukh&limit=100`)
        .set(as('member'))
        .expect(200);
      const card = listOf(PackageCardSchema, list).find((p) => p.id === packageId);
      expect(card).toMatchObject({
        commercial: true,
        pricePaise: 349_900,
        seatsLeft: 12,
        operator: { verified: true, category: 'TREKKING' },
      });
      expect(card?.coverImageUrl).toContain('/package-photos/');

      const detail = dataOf(
        PackageDetailSchema,
        await http().get(`/api/v1/packages/${packageId}`).set(as('member')).expect(200),
      );
      expect(detail).toMatchObject({
        commercial: true,
        status: 'PUBLISHED',
        pricePaise: 349_900,
        currency: 'INR',
        inclusions: ['Forest entry permit', 'Guide', 'Two meals'],
        exclusions: ['Travel to the base village'],
        cancellationPolicy: packageInput().cancellationPolicy,
        bookingOpen: false,
        viewer: { isOperator: false, canAsk: true },
        // About a kilometre, never the exact spot.
        meetingPoint: { name: 'Mullodi village', approximate: true },
      });
      expect(detail.meetingPoint.point).toEqual({ latitude: 13.12, longitude: 75.27 });
      // The business's private details don't leak into the listing.
      const raw = JSON.stringify(
        (await http().get(`/api/v1/packages/${packageId}`).set(as('member'))).body,
      );
      for (const secret of ['hello@ghats-treks.example', '29ABCDE1234F1Z5', '12 MG Road']) {
        expect(raw).not.toContain(secret);
      }

      const operator = dataOf(
        PublicOperatorSchema,
        await http().get(`/api/v1/operators/${detail.operator.slug}`).set(as('member')).expect(200),
      );
      expect(operator).toMatchObject({ verified: true, city: 'Bengaluru' });
      expect(operator.packages.map((p) => p.id)).toContain(packageId);
    });

    it('locks a published package and the legal name of a verified business', async () => {
      const base = `/api/v1/me/operator/packages/${packageId}`;
      await http().patch(base).set(as('owner')).send({ pricePaise: 299_900 }).expect(409);
      await http()
        .patch('/api/v1/me/operator')
        .set(as('owner'))
        .send({ legalName: 'Another Legal Name' })
        .expect(409);
      await http()
        .patch('/api/v1/me/operator')
        .set(as('owner'))
        .send({ description: 'Small-group treks in the Western Ghats.' })
        .expect(200);

      await http().post(`${base}/unpublish`).set(as('owner')).expect(200);
      const edited = dataOf(
        OwnPackageSchema,
        await http()
          .patch(base)
          .set(as('owner'))
          .send({ pricePaise: 299_900, capacity: 10 })
          .expect(200),
      );
      expect(edited).toMatchObject({ status: 'DRAFT', pricePaise: 299_900, capacity: 10 });
      // Rules apply to the merged package, not only the fields sent.
      await http()
        .patch(base)
        .set(as('owner'))
        .send({ endsAt: at(24 * 5) })
        .expect(400);
      await http().patch(base).set(as('owner')).send({ capacity: 500 }).expect(400);
      await http().post(`${base}/publish`).set(as('owner')).expect(200);
    });

    it('rejects an incomplete published package in the database', async () => {
      await expect(
        prisma().commercialPackage.update({
          where: { id: packageId },
          data: { inclusions: [] },
        }),
      ).rejects.toThrow(/commercial_packages_published_complete/);
      await expect(
        prisma().commercialPackage.update({
          where: { id: packageId },
          data: { pricePaise: 100_000_001 },
        }),
      ).rejects.toThrow(/commercial_packages_price_max/);
    });

    it('counts views once a day per member, not the operator’s own', async () => {
      const before = await prisma().commercialPackage.findUniqueOrThrow({
        where: { id: packageId },
        select: { viewCount: true },
      });
      for (const name of ['member', 'member', 'owner', 'other'] as const) {
        await http().get(`/api/v1/packages/${packageId}`).set(as(name)).expect(200);
      }
      const after = await prisma().commercialPackage.findUniqueOrThrow({
        where: { id: packageId },
        select: { viewCount: true },
      });
      // The member already viewed it earlier today; only "other" is new.
      expect(after.viewCount - before.viewCount).toBe(1);
    });
  });

  describe('questions', () => {
    it('lets members ask, the operator answer, and shows answers publicly', async () => {
      const ask = (name: Name, question: string) =>
        http().post(`/api/v1/packages/${packageId}/questions`).set(as(name)).send({ question });
      await ask('owner', 'Is this my own package?').expect(403);
      await ask('member', 'Hi').expect(400);
      const asked = dataOf(
        PackageQuestionSchema,
        await ask('member', 'Is a sleeping bag provided?').expect(201),
      );
      expect(asked).toMatchObject({ mine: true, answer: null });

      // The operator hears about it and sees who asked.
      const notes = await http().get('/api/v1/me/notifications').set(as('owner')).expect(200);
      const note = listOf(NotificationSchema, notes)[0];
      expect(note?.data).toMatchObject({ packageId, screen: 'questions' });
      const inbox = await http()
        .get('/api/v1/me/operator/questions?unanswered=true')
        .set(as('owner'))
        .expect(200);
      expect(listOf(PackageQuestionSchema, inbox)[0]).toMatchObject({
        id: asked.id,
        asker: { username: `${prefix}_member` },
      });

      // Unanswered questions stay between the asker and the operator.
      const forOther = await http()
        .get(`/api/v1/packages/${packageId}/questions`)
        .set(as('other'))
        .expect(200);
      expect(listOf(PackageQuestionSchema, forOther)).toEqual([]);

      await http()
        .post(`/api/v1/package-questions/${asked.id}/answer`)
        .set(as('other'))
        .send({ answer: 'Yes' })
        .expect(404);
      await http()
        .post(`/api/v1/package-questions/${asked.id}/answer`)
        .set(as('owner'))
        .send({ answer: 'Yes, and a mat too.' })
        .expect(200);
      const publicList = listOf(
        PackageQuestionSchema,
        await http().get(`/api/v1/packages/${packageId}/questions`).set(as('other')).expect(200),
      );
      // Answered questions are public, without the asker's name.
      expect(publicList).toMatchObject([
        { id: asked.id, answer: 'Yes, and a mat too.', asker: null, mine: false },
      ]);
      const answeredNote = await http()
        .get('/api/v1/me/notifications')
        .set(as('member'))
        .expect(200);
      expect(listOf(NotificationSchema, answeredNote)[0]?.data).toMatchObject({
        packageId,
      });
    });

    it('limits questions per package per day', async () => {
      for (let i = 0; i < 2; i++) {
        await http()
          .post(`/api/v1/packages/${packageId}/questions`)
          .set(as('member'))
          .send({ question: `Follow-up question number ${i + 1}?` })
          .expect(201);
      }
      await http()
        .post(`/api/v1/packages/${packageId}/questions`)
        .set(as('member'))
        .send({ question: 'One question too many?' })
        .expect(429);
    });

    it('lets the operator hide a question', async () => {
      const inbox = listOf(
        PackageQuestionSchema,
        await http().get('/api/v1/me/operator/questions').set(as('owner')).expect(200),
      );
      const target = inbox.find((q) => q.answer === null)!;
      const hidden = dataOf(
        PackageQuestionSchema,
        await http()
          .post(`/api/v1/package-questions/${target.id}/hide`)
          .set(as('owner'))
          .expect(200),
      );
      expect(hidden.hidden).toBe(true);
      await http()
        .post(`/api/v1/package-questions/${target.id}/answer`)
        .set(as('owner'))
        .send({ answer: 'Too late' })
        .expect(409);
      const own = await http()
        .get(`/api/v1/packages/${packageId}/questions`)
        .set(as('member'))
        .expect(200);
      expect(listOf(PackageQuestionSchema, own).map((q) => q.id)).not.toContain(target.id);
    });
  });

  describe('bookings, dashboard and moderation', () => {
    it('counts held seats and blocks unpublishing a booked package', async () => {
      await prisma().booking.create({
        data: {
          userId: ids.member,
          packageId,
          seats: 3,
          status: 'CONFIRMED',
          unitPricePaise: 349_900,
          totalAmountPaise: 349_900 * 3,
          ...bookingFields(349_900 * 3, { status: 'CONFIRMED' }),
        },
      });
      const detail = dataOf(
        PackageDetailSchema,
        await http().get(`/api/v1/packages/${packageId}`).set(as('other')).expect(200),
      );
      expect(detail.seatsLeft).toBe(detail.capacity - 3);
      await http()
        .post(`/api/v1/me/operator/packages/${packageId}/unpublish`)
        .set(as('owner'))
        .expect(409);
      await http()
        .post(`/api/v1/me/operator/packages/${packageId}/archive`)
        .set(as('owner'))
        .expect(409);
    });

    it('summarises the business on the dashboard', async () => {
      const dash = dataOf(
        OperatorDashboardSchema,
        await http().get('/api/v1/me/operator/dashboard').set(as('owner')).expect(200),
      );
      expect(dash).toMatchObject({
        operator: { verificationStatus: 'VERIFIED', canPublish: true, inReview: false },
        packages: { draft: 0, published: 1, upcoming: 1, suspended: 0, archived: 0 },
        bookings: { total: 1, confirmed: 1, seats: 3 },
        // The hidden question doesn't count.
        questions: { unanswered: 1, answered: 1 },
        performance: { answerRatePercent: 50 },
      });
      expect(dash.performance.listingViews).toBeGreaterThanOrEqual(2);
      await http().get('/api/v1/me/operator/dashboard').set(as('member')).expect(404);
    });

    it('lets members report a package, but not their own', async () => {
      const report = (name: Name) =>
        http()
          .post('/api/v1/reports')
          .set(as(name))
          .send({ targetType: 'COMMERCIAL_PACKAGE', targetId: packageId, reason: 'SCAM_OR_FRAUD' });
      await report('owner').expect(409);
      await report('member').expect(201);
    });

    it('lets moderators suspend and restore a package', async () => {
      const base = `/api/v1/admin/operators/${operatorId}/packages/${packageId}`;
      const reason = { reason: 'Misleading price in the listing' };
      await http().post(`${base}/suspend`).set(as('ops')).send(reason).expect(403);
      await http().post(`${base}/suspend`).set(as('mod')).send(reason).expect(200);

      await http().get(`/api/v1/packages/${packageId}`).set(as('member')).expect(404);
      const own = dataOf(
        OwnPackageSchema,
        await http().get(`/api/v1/me/operator/packages/${packageId}`).set(as('owner')).expect(200),
      );
      expect(own).toMatchObject({ status: 'SUSPENDED', suspendedReason: reason.reason });
      expect(own.actions).toEqual([]);
      await http()
        .post(`/api/v1/me/operator/packages/${packageId}/publish`)
        .set(as('owner'))
        .expect(409);
      // Moderators can still look at it.
      await http().get(`/api/v1/packages/${packageId}`).set(as('mod')).expect(200);

      await http().post(`${base}/restore`).set(as('mod')).send(reason).expect(200);
      const restored = await prisma().commercialPackage.findUniqueOrThrow({
        where: { id: packageId },
        select: { status: true, suspendedReason: true },
      });
      expect(restored).toEqual({ status: 'DRAFT', suspendedReason: null });
      const audit = await prisma().auditLog.findMany({
        where: { entityId: operatorId, action: { startsWith: 'package.' } },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a) => a.action)).toEqual(['package.suspend', 'package.restore']);
      await http()
        .post(`/api/v1/me/operator/packages/${packageId}/publish`)
        .set(as('owner'))
        .expect(200);
    });

    it('hides every listing of a suspended business', async () => {
      await http()
        .post(`/api/v1/admin/operators/${operatorId}/status`)
        .set(as('ops'))
        .send({ status: 'SUSPENDED', reason: 'Complaints under investigation' })
        .expect(200);
      await http().get(`/api/v1/packages/${packageId}`).set(as('member')).expect(404);
      const list = await http().get('/api/v1/packages?limit=100').set(as('member')).expect(200);
      expect(listOf(PackageCardSchema, list).map((p) => p.id)).not.toContain(packageId);
      await http()
        .post('/api/v1/me/operator/packages')
        .set(as('owner'))
        .send(packageInput())
        .expect(409);
    });
  });
});
