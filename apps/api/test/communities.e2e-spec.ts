import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  type AuthTokens,
  CommunityMemberSchema,
  CommunitySchema,
  type CreateTripInput,
  FeedItemSchema,
  PostSchema,
  PublicProfileSchema,
  TripSchema,
  TripSummarySchema,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { bearer, login, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/** Communities, follows, blocks, reports, posts and the feed against the real database. */
const prefix = `cs_${randomUUID().slice(0, 6)}`;
const slugBase = prefix.replace('_', '-');
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const dataOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  schema.parse((res.body as { data: unknown }).data);
const pageOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  z.object({ data: z.array(schema) }).parse(res.body).data;

const NAMES = ['owner', 'admin', 'mod', 'member', 'outsider', 'blocker', 'fan'] as const;
type Name = (typeof NAMES)[number];

const tripBody = (overrides: Partial<CreateTripInput> = {}): CreateTripInput => ({
  mode: 'TRAVEL',
  activityType: 'TREK',
  title: 'Kumara Parvatha trek',
  origin: { name: 'Kukke', point: { latitude: 12.6631, longitude: 75.6131 } },
  destination: { name: 'Kumara Parvatha', point: { latitude: 12.6522, longitude: 75.6908 } },
  departureAt: inHours(96),
  maxParticipants: 8,
  visibility: 'PUBLIC',
  ...overrides,
});

describe('communities and social (e2e)', () => {
  let app: INestApplication<App>;
  const tokens = {} as Record<Name, AuthTokens>;
  const ids = {} as Record<Name, string>;
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  const as = (name: Name) => ({ authorization: bearer(tokens[name]) });
  const uname = (name: Name) => `${prefix}_${name}`;
  let slugCount = 0;

  const createCommunity = async (by: Name, overrides: object = {}) => {
    slugCount += 1;
    const res = await http()
      .post('/api/v1/communities')
      .set(as(by))
      .send({
        name: `Riders ${slugCount}`,
        slug: `${slugBase}-c${slugCount}`,
        category: 'RIDING_CLUB',
        city: 'Bengaluru',
        ...overrides,
      })
      .expect(201);
    return dataOf(CommunitySchema, res);
  };
  const getCommunity = async (name: Name, slug: string) =>
    dataOf(CommunitySchema, await http().get(`/api/v1/communities/${slug}`).set(as(name)));
  const join = (name: Name, slug: string, message?: string) =>
    http()
      .post(`/api/v1/communities/${slug}/join`)
      .set(as(name))
      .send(message ? { message } : {});
  const member = (by: Name, slug: string, who: Name, verb: string, payload: object = {}) =>
    http()
      .post(`/api/v1/communities/${slug}/members/${ids[who]}/${verb}`)
      .set(as(by))
      .send(payload);
  const feed = async (name: Name) =>
    pageOf(FeedItemSchema, await http().get('/api/v1/feed?limit=50').set(as(name)).expect(200));

  /** A public community with an owner, an admin, a moderator and a member. */
  const staffedCommunity = async (overrides: object = {}) => {
    const community = await createCommunity('owner', overrides);
    for (const name of ['admin', 'mod', 'member'] as const) {
      await join(name, community.slug).expect(200);
      if (community.joinPolicy === 'APPROVAL') {
        await member('owner', community.slug, name, 'approve').expect(204);
      }
    }
    await member('owner', community.slug, 'admin', 'role', { role: 'ADMIN' }).expect(204);
    await member('owner', community.slug, 'mod', 'role', { role: 'MODERATOR' }).expect(204);
    return community;
  };

  beforeAll(async () => {
    app = await startAuthApp();
    for (const name of NAMES) {
      await registerAndLogin(app, {
        email: `${prefix}_${name}@example.test`,
        username: uname(name),
      });
      tokens[name] = await login(app, `${prefix}_${name}@example.test`);
      ids[name] = (await prisma().user.findUniqueOrThrow({ where: { username: uname(name) } })).id;
    }
  });

  afterAll(async () => {
    const userIds = Object.values(ids);
    await prisma().post.deleteMany({ where: { authorId: { in: userIds } } });
    await prisma().trip.deleteMany({ where: { organiserId: { in: userIds } } });
    await prisma().community.deleteMany({ where: { slug: { startsWith: slugBase } } });
    await prisma().report.deleteMany({ where: { reporterId: { in: userIds } } });
    await prisma().user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  describe('creating and joining', () => {
    it('creates a community with the creator as owner, and rejects a taken slug', async () => {
      const created = await createCommunity('owner', { description: 'Weekend rides' });
      expect(created).toMatchObject({
        visibility: 'PUBLIC',
        joinPolicy: 'OPEN',
        memberCount: 1,
        owner: { id: ids.owner },
        viewer: { role: 'OWNER', status: 'ACTIVE', canSeeContent: true },
      });
      expect(created.viewer.actions).toEqual(['edit', 'moderate', 'announce']);
      await http()
        .post('/api/v1/communities')
        .set(as('member'))
        .send({ name: 'Copy', slug: created.slug })
        .expect(409);
      // Private communities must approve members.
      await http()
        .post('/api/v1/communities')
        .set(as('member'))
        .send({ name: 'Bad', slug: `${slugBase}-bad`, visibility: 'PRIVATE', joinPolicy: 'OPEN' })
        .expect(400);
      const found = pageOf(
        CommunitySchema,
        await http()
          .get(`/api/v1/communities?q=${encodeURIComponent('Riders')}&limit=50`)
          .set(as('fan')),
      );
      expect(found.map((c) => c.slug)).toContain(created.slug);
    });

    it('joins open communities at once and leaves them; the owner cannot leave', async () => {
      const community = await createCommunity('owner');
      expect((await getCommunity('fan', community.slug)).viewer.actions).toEqual(['join']);
      const joined = dataOf(CommunitySchema, await join('fan', community.slug).expect(200));
      expect(joined.viewer).toMatchObject({ role: 'MEMBER', status: 'ACTIVE' });
      expect(joined.memberCount).toBe(2);
      await join('fan', community.slug).expect(409);
      const left = dataOf(
        CommunitySchema,
        await http().post(`/api/v1/communities/${community.slug}/leave`).set(as('fan')).expect(200),
      );
      expect(left.viewer.status).toBe('LEFT');
      expect(left.viewer.actions).toEqual(['join']);
      await http().post(`/api/v1/communities/${community.slug}/leave`).set(as('owner')).expect(409);
    });

    it('keeps a private community to its members, through the request flow', async () => {
      const community = await createCommunity('owner', { visibility: 'PRIVATE' });
      expect(community.joinPolicy).toBe('APPROVAL');
      const card = await getCommunity('outsider', community.slug);
      expect(card).toMatchObject({ name: community.name, viewer: { canSeeContent: false } });
      expect(card.viewer.actions).toEqual(['request']);
      for (const path of ['members', 'trips', 'posts']) {
        await http()
          .get(`/api/v1/communities/${community.slug}/${path}`)
          .set(as('outsider'))
          .expect(403);
      }

      const asked = dataOf(
        CommunitySchema,
        await join('outsider', community.slug, 'I ride every weekend').expect(200),
      );
      expect(asked.viewer).toMatchObject({ status: 'PENDING', canSeeContent: false });
      expect(asked.viewer.actions).toEqual(['cancel_request']);
      const notes = await prisma().notification.findMany({
        where: { userId: ids.owner, type: 'COMMUNITY_UPDATE' },
      });
      expect(notes.length).toBeGreaterThan(0);

      const requests = pageOf(
        CommunityMemberSchema,
        await http()
          .get(`/api/v1/communities/${community.slug}/members?status=PENDING`)
          .set(as('owner'))
          .expect(200),
      );
      expect(requests).toEqual([
        expect.objectContaining({ message: 'I ride every weekend', status: 'PENDING' }),
      ]);
      await http()
        .get(`/api/v1/communities/${community.slug}/members?status=PENDING`)
        .set(as('outsider'))
        .expect(403);

      await member('owner', community.slug, 'outsider', 'approve').expect(204);
      const inside = await getCommunity('outsider', community.slug);
      expect(inside.viewer).toMatchObject({ status: 'ACTIVE', canSeeContent: true });
      await http()
        .get(`/api/v1/communities/${community.slug}/members`)
        .set(as('outsider'))
        .expect(200);
      expect(
        await prisma().auditLog.count({
          where: { actorId: ids.owner, action: 'community.member_approve' },
        }),
      ).toBeGreaterThan(0);
    });
  });

  describe('moderation', () => {
    it('ranks roles so nobody can raise their own privileges', async () => {
      const community = await staffedCommunity();
      const { slug } = community;
      // Moderators cannot change roles at all; admins only below their own rank.
      await member('mod', slug, 'member', 'role', { role: 'MODERATOR' }).expect(403);
      await member('mod', slug, 'mod', 'role', { role: 'ADMIN' }).expect(403);
      await member('admin', slug, 'admin', 'role', { role: 'MEMBER' }).expect(403);
      await member('admin', slug, 'member', 'role', { role: 'ADMIN' }).expect(403);
      await member('admin', slug, 'owner', 'role', { role: 'MEMBER' }).expect(403);
      await member('admin', slug, 'member', 'role', { role: 'MODERATOR' }).expect(204);
      await member('admin', slug, 'member', 'role', { role: 'MEMBER' }).expect(204);
      await member('member', slug, 'mod', 'remove').expect(403);
      await member('mod', slug, 'admin', 'remove').expect(403);
      await member('mod', slug, 'mod', 'remove').expect(409);
      expect(
        await prisma().auditLog.count({
          where: { action: 'community.role_change', entityId: community.id },
        }),
      ).toBe(4);

      const view = await getCommunity('mod', slug);
      expect(view.viewer.actions).toEqual(['leave', 'moderate', 'announce']);
    });

    it('removes and bans members, and lifts bans', async () => {
      const { slug } = await staffedCommunity();
      await join('fan', slug).expect(200);
      await member('mod', slug, 'fan', 'remove', { reason: 'Spamming the group' }).expect(204);
      expect((await getCommunity('fan', slug)).viewer.status).toBe('REMOVED');
      await join('fan', slug).expect(200);

      await member('mod', slug, 'fan', 'remove', { ban: true }).expect(204);
      await join('fan', slug).expect(403);
      expect((await getCommunity('fan', slug)).viewer.actions).toEqual([]);
      const banned = pageOf(
        CommunityMemberSchema,
        await http().get(`/api/v1/communities/${slug}/members?status=BANNED`).set(as('mod')),
      );
      expect(banned.map((m) => m.user.id)).toEqual([ids.fan]);
      await member('mod', slug, 'fan', 'unban').expect(403);
      await member('admin', slug, 'fan', 'unban').expect(204);
      await join('fan', slug).expect(200);
      expect(
        await prisma().auditLog.count({
          where: { action: 'community.member_ban', actorId: ids.mod },
        }),
      ).toBeGreaterThan(0);
    });

    it('lets moderators announce and delete posts, and admins edit', async () => {
      const { slug } = await staffedCommunity();
      await http()
        .post(`/api/v1/communities/${slug}/announcements`)
        .set(as('member'))
        .send({ body: 'Hello' })
        .expect(403);
      const announcement = dataOf(
        PostSchema,
        await http()
          .post(`/api/v1/communities/${slug}/announcements`)
          .set(as('mod'))
          .send({ body: 'Ride to Nandi on Sunday, meet at 5 AM', membersOnly: true })
          .expect(201),
      );
      expect(announcement).toMatchObject({ type: 'ANNOUNCEMENT', visibility: 'COMMUNITY' });
      expect(
        (
          await prisma().notification.findFirst({
            where: { userId: ids.member, type: 'COMMUNITY_UPDATE' },
            orderBy: { createdAt: 'desc' },
          })
        )?.title,
      ).toContain('Announcement');
      // Members-only posts are hidden from non-members of a public community.
      const outside = pageOf(
        PostSchema,
        await http().get(`/api/v1/communities/${slug}/posts`).set(as('outsider')).expect(200),
      );
      expect(outside.map((p) => p.id)).not.toContain(announcement.id);

      await http()
        .patch(`/api/v1/communities/${slug}`)
        .set(as('mod'))
        .send({ description: 'Changed' })
        .expect(403);
      const edited = dataOf(
        CommunitySchema,
        await http()
          .patch(`/api/v1/communities/${slug}`)
          .set(as('admin'))
          .send({ description: 'Sunday rides around Bengaluru' })
          .expect(200),
      );
      expect(edited.description).toBe('Sunday rides around Bengaluru');

      const memberPost = dataOf(
        PostSchema,
        await http()
          .post('/api/v1/posts')
          .set(as('member'))
          .send({ type: 'PHOTO', body: 'x', communityId: edited.id })
          .expect(400)
          .then(async () =>
            http()
              .post('/api/v1/communities/' + slug + '/announcements')
              .set(as('admin'))
              .send({ body: 'Second announcement' })
              .expect(201),
          ),
      );
      await http().delete(`/api/v1/posts/${memberPost.id}`).set(as('member')).expect(403);
      await http().delete(`/api/v1/posts/${memberPost.id}`).set(as('mod')).expect(204);
      expect(
        await prisma().auditLog.count({
          where: { action: 'post.moderate_delete', entityId: memberPost.id },
        }),
      ).toBe(1);
    });
  });

  describe('community trips', () => {
    it('shows members-only trips to members only, and checks membership when posting one', async () => {
      const community = await createCommunity('owner');
      await join('member', community.slug).expect(200);
      await http()
        .post('/api/v1/trips')
        .set(as('outsider'))
        .send(tripBody({ visibility: 'COMMUNITY', communityId: community.id }))
        .expect(400);
      await http()
        .post('/api/v1/trips')
        .set(as('owner'))
        .send(tripBody({ visibility: 'COMMUNITY' }))
        .expect(400);
      const res = await http()
        .post('/api/v1/trips')
        .set(as('owner'))
        .send(tripBody({ visibility: 'COMMUNITY', communityId: community.id }))
        .expect(201);
      const trip = dataOf(TripSchema, res);
      expect(trip.community).toEqual({
        id: community.id,
        slug: community.slug,
        name: community.name,
      });
      await http().post(`/api/v1/trips/${trip.id}/publish`).set(as('owner')).expect(200);

      const forMember = pageOf(
        TripSummarySchema,
        await http()
          .get(`/api/v1/communities/${community.slug}/trips`)
          .set(as('member'))
          .expect(200),
      );
      expect(forMember.map((t) => t.id)).toEqual([trip.id]);
      const forOutsider = pageOf(
        TripSummarySchema,
        await http()
          .get(`/api/v1/communities/${community.slug}/trips`)
          .set(as('outsider'))
          .expect(200),
      );
      expect(forOutsider).toEqual([]);
      await http().get(`/api/v1/trips/${trip.id}`).set(as('outsider')).expect(404);
      const seen = await http().get(`/api/v1/trips/${trip.id}`).set(as('member')).expect(200);
      expect(dataOf(TripSchema, seen).viewer.actions).toContain('join');
      await http()
        .post(`/api/v1/trips/${trip.id}/join-requests`)
        .set(as('member'))
        .send({})
        .expect(201);

      // Leaving the community hides its members-only trips again.
      await http()
        .post(`/api/v1/communities/${community.slug}/leave`)
        .set(as('member'))
        .expect(200);
      await http().get(`/api/v1/trips/${trip.id}`).set(as('member')).expect(404);
    });
  });

  describe('follows, blocks and reports', () => {
    it('follows and unfollows, with counts and mutual state', async () => {
      await http()
        .post(`/api/v1/users/${uname('member')}/follow`)
        .set(as('fan'))
        .expect(204);
      await http()
        .post(`/api/v1/users/${uname('member')}/follow`)
        .set(as('fan'))
        .expect(204);
      await http()
        .post(`/api/v1/users/${uname('fan')}/follow`)
        .set(as('fan'))
        .expect(409);
      const profile = dataOf(
        PublicProfileSchema,
        await http()
          .get(`/api/v1/users/${uname('member')}`)
          .set(as('fan'))
          .expect(200),
      );
      expect(profile.follow).toMatchObject({ followerCount: 1, isFollowing: true, mutual: false });
      const notes = await prisma().notification.findMany({
        where: { userId: ids.member, type: 'NEW_FOLLOWER' },
      });
      expect(notes).toHaveLength(1);
      expect(notes[0]?.data).toEqual({ username: uname('fan') });

      await http()
        .post(`/api/v1/users/${uname('fan')}/follow`)
        .set(as('member'))
        .expect(204);
      const mutual = dataOf(
        PublicProfileSchema,
        await http()
          .get(`/api/v1/users/${uname('member')}`)
          .set(as('fan')),
      );
      expect(mutual.follow).toMatchObject({ followsYou: true, mutual: true });

      const followers = z
        .object({ data: z.array(z.object({ user: z.object({ id: z.string() }) })) })
        .parse(
          (
            await http()
              .get(`/api/v1/users/${uname('member')}/followers`)
              .set(as('outsider'))
          ).body,
        ).data;
      expect(followers.map((f) => f.user.id)).toEqual([ids.fan]);

      await http()
        .delete(`/api/v1/users/${uname('member')}/follow`)
        .set(as('fan'))
        .expect(204);
      const after = dataOf(
        PublicProfileSchema,
        await http()
          .get(`/api/v1/users/${uname('member')}`)
          .set(as('fan')),
      );
      expect(after.follow).toMatchObject({ followerCount: 0, isFollowing: false, mutual: false });
    });

    it('hides followers of private profiles, and who follows you back', async () => {
      await prisma().userPreference.upsert({
        where: { userId: ids.admin },
        create: { userId: ids.admin, profileVisibility: 'PRIVATE' },
        update: { profileVisibility: 'PRIVATE' },
      });
      await http()
        .post(`/api/v1/users/${uname('outsider')}/follow`)
        .set(as('admin'))
        .expect(204);
      await http()
        .get(`/api/v1/users/${uname('admin')}/followers`)
        .set(as('outsider'))
        .expect(403);
      const profile = dataOf(
        PublicProfileSchema,
        await http()
          .get(`/api/v1/users/${uname('admin')}`)
          .set(as('outsider')),
      );
      expect(profile.limited).toBe(true);
      expect(profile.follow.followsYou).toBe(false);
    });

    it('blocks both ways: profiles, follows, invitations and content', async () => {
      await http()
        .post(`/api/v1/users/${uname('blocker')}/follow`)
        .set(as('fan'))
        .expect(204);
      await http()
        .post(`/api/v1/users/${uname('fan')}/follow`)
        .set(as('blocker'))
        .expect(204);
      await http()
        .post(`/api/v1/users/${uname('fan')}/block`)
        .set(as('blocker'))
        .expect(204);
      expect(
        await prisma().follow.count({
          where: {
            OR: [
              { followerId: ids.fan, followeeId: ids.blocker },
              { followerId: ids.blocker, followeeId: ids.fan },
            ],
          },
        }),
      ).toBe(0);
      await http()
        .get(`/api/v1/users/${uname('blocker')}`)
        .set(as('fan'))
        .expect(404);
      await http()
        .get(`/api/v1/users/${uname('fan')}`)
        .set(as('blocker'))
        .expect(404);
      await http()
        .post(`/api/v1/users/${uname('blocker')}/follow`)
        .set(as('fan'))
        .expect(404);
      const blocks = z
        .object({ data: z.array(z.object({ user: z.object({ id: z.string() }) })) })
        .parse((await http().get('/api/v1/me/blocks').set(as('blocker')).expect(200)).body).data;
      expect(blocks.map((b) => b.user.id)).toEqual([ids.fan]);

      // A community owned by someone who blocked you cannot be joined.
      const community = await createCommunity('blocker');
      await join('fan', community.slug).expect(403);

      await http()
        .delete(`/api/v1/users/${uname('fan')}/block`)
        .set(as('blocker'))
        .expect(204);
      await http()
        .get(`/api/v1/users/${uname('blocker')}`)
        .set(as('fan'))
        .expect(200);
      await http()
        .post(`/api/v1/users/${uname('blocker')}/block`)
        .set(as('blocker'))
        .expect(409);
    });

    it('files reports, merging repeats, and refuses self-reports', async () => {
      const community = await createCommunity('owner');
      const send = (payload: object) => http().post('/api/v1/reports').set(as('fan')).send(payload);
      const first = await send({
        targetType: 'COMMUNITY',
        targetId: community.id,
        reason: 'SPAM',
        details: 'Advertising',
      }).expect(201);
      const again = await send({
        targetType: 'COMMUNITY',
        targetId: community.id,
        reason: 'SPAM',
      }).expect(201);
      expect((again.body as { data: { id: string } }).data.id).toBe(
        (first.body as { data: { id: string } }).data.id,
      );
      const report = await prisma().report.findFirstOrThrow({
        where: { targetId: community.id },
      });
      expect(report.reportedUserId).toBe(ids.owner);
      await send({ targetType: 'USER', targetId: ids.fan, reason: 'SPAM' }).expect(409);
      await send({ targetType: 'POST', targetId: randomUUID(), reason: 'SPAM' }).expect(404);
      await send({ targetType: 'USER', targetId: ids.owner, reason: 'NOT_A_REASON' }).expect(400);
    });
  });

  describe('posts and feed', () => {
    const completedTrip = async (
      by: Name,
      withMember: Name,
      overrides: Partial<CreateTripInput> = {},
    ) => {
      const trip = dataOf(
        TripSchema,
        await http().post('/api/v1/trips').set(as(by)).send(tripBody(overrides)).expect(201),
      );
      await http().post(`/api/v1/trips/${trip.id}/publish`).set(as(by)).expect(200);
      await prisma().tripParticipant.create({
        data: { tripId: trip.id, userId: ids[withMember], status: 'COMPLETED' },
      });
      await prisma().trip.update({
        where: { id: trip.id },
        data: { status: 'COMPLETED', startedAt: new Date(), completedAt: new Date() },
      });
      return trip.id;
    };

    it('only allows recaps of completed trips you were on, and photos need uploads', async () => {
      const done = await completedTrip('owner', 'member');
      const post = (name: Name, payload: object) =>
        http().post('/api/v1/posts').set(as(name)).send(payload);
      await post('outsider', { type: 'TRIP_RECAP', tripId: done, body: 'Great trek' }).expect(400);
      await post('member', { type: 'TRIP_RECAP', body: 'No trip' }).expect(400);
      const recap = dataOf(
        PostSchema,
        await post('member', { type: 'TRIP_RECAP', tripId: done, body: 'Great trek!' }).expect(201),
      );
      expect(recap).toMatchObject({
        type: 'TRIP_RECAP',
        trip: { id: done },
        author: { id: ids.member },
        canDelete: true,
      });
      const upcoming = dataOf(
        TripSchema,
        await http().post('/api/v1/trips').set(as('member')).send(tripBody()).expect(201),
      );
      await post('member', { type: 'TRIP_RECAP', tripId: upcoming.id, body: 'Soon' }).expect(400);
      // Without Cloudinary configured, photos cannot be checked, so they are refused honestly.
      await post('member', {
        type: 'PHOTO',
        imageIds: [`voyago-dev/post-photos/${ids.member}/${randomUUID()}`],
      }).expect(503);
      await http().delete(`/api/v1/posts/${recap.id}`).set(as('outsider')).expect(403);
      await http().delete(`/api/v1/posts/${recap.id}`).set(as('member')).expect(204);
      await http().delete(`/api/v1/posts/${recap.id}`).set(as('member')).expect(404);
    });

    it('shows followed people, own posts and my communities, newest first', async () => {
      // A fresh pair so earlier tests don't affect the feed.
      const community = await createCommunity('owner', { visibility: 'PRIVATE' });
      const done = await completedTrip('mod', 'member');
      const recap = dataOf(
        PostSchema,
        await http()
          .post('/api/v1/posts')
          .set(as('mod'))
          .send({
            type: 'TRIP_RECAP',
            tripId: done,
            body: 'Summit at sunrise',
            visibility: 'FOLLOWERS',
          })
          .expect(201),
      );
      const announcement = dataOf(
        PostSchema,
        await http()
          .post(`/api/v1/communities/${community.slug}/announcements`)
          .set(as('owner'))
          .send({ body: 'Private meetup on Friday' })
          .expect(201),
      );
      expect(announcement.visibility).toBe('COMMUNITY');
      const publicTrip = dataOf(
        TripSchema,
        await http()
          .post('/api/v1/trips')
          .set(as('mod'))
          .send(tripBody({ title: 'Feed trip' }))
          .expect(201),
      );
      await http().post(`/api/v1/trips/${publicTrip.id}/publish`).set(as('mod')).expect(200);

      // Not following, not a member: nothing of theirs.
      const before = await feed('outsider');
      const ids0 = before.map((item) => (item.kind === 'post' ? item.post.id : item.trip.id));
      expect(ids0).not.toContain(recap.id);
      expect(ids0).not.toContain(announcement.id);
      expect(ids0).not.toContain(publicTrip.id);

      await http()
        .post(`/api/v1/users/${uname('mod')}/follow`)
        .set(as('outsider'))
        .expect(204);
      const following = await feed('outsider');
      const ids1 = following.map((item) => (item.kind === 'post' ? item.post.id : item.trip.id));
      expect(ids1).toContain(recap.id); // followers-only post, now a follower
      expect(ids1).toContain(publicTrip.id);
      expect(ids1).not.toContain(announcement.id);
      // Newest first.
      const times = following.map((item) => item.at);
      expect([...times].sort().reverse()).toEqual(times);

      await join('outsider', community.slug).expect(200);
      await member('owner', community.slug, 'outsider', 'approve').expect(204);
      const asMember = await feed('outsider');
      expect(asMember.map((i) => (i.kind === 'post' ? i.post.id : i.trip.id))).toContain(
        announcement.id,
      );

      // A block hides their posts and trips from the feed, both ways.
      await http()
        .post(`/api/v1/users/${uname('outsider')}/block`)
        .set(as('mod'))
        .expect(204);
      const blocked = await feed('outsider');
      const ids2 = blocked.map((item) => (item.kind === 'post' ? item.post.id : item.trip.id));
      expect(ids2).not.toContain(recap.id);
      expect(ids2).not.toContain(publicTrip.id);
      await http()
        .delete(`/api/v1/users/${uname('outsider')}/block`)
        .set(as('mod'))
        .expect(204);
    });

    it('pages through the feed without repeats', async () => {
      for (let i = 0; i < 3; i += 1) {
        await http()
          .post(`/api/v1/communities/${(await createCommunity('fan')).slug}/announcements`)
          .set(as('fan'))
          .send({ body: `Note ${i}` })
          .expect(201);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await http()
          .get(`/api/v1/feed?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
          .set(as('fan'))
          .expect(200);
        const body = z
          .object({
            data: z.array(FeedItemSchema),
            page: z.object({ nextCursor: z.string().nullable() }),
          })
          .parse(res.body);
        seen.push(...body.data.map((i) => (i.kind === 'post' ? i.post.id : i.trip.id)));
        cursor = body.page.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBeGreaterThanOrEqual(3);
    });
  });
});
