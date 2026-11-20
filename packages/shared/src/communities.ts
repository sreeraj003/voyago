import { z } from 'zod';
import { CommunityCoverIdSchema, PostPhotoIdSchema } from './maps-media.js';
import { CursorPageQuerySchema } from './pagination.js';
import { PersonSummarySchema } from './social.js';
import { TripModeSchema } from './trip-mode.js';
import { TripStatusSchema } from './trips.js';

/**
 * Communities, their members and posts, and the activity feed. Private communities show their
 * name and description to everyone (so people can ask to join) and everything else only to
 * members.
 */

export const CommunityVisibilitySchema = z.enum(['PUBLIC', 'PRIVATE']);
export const CommunityJoinPolicySchema = z.enum(['OPEN', 'APPROVAL']);
export const CommunityCategorySchema = z.enum([
  'RIDING_CLUB',
  'TOURING',
  'TREKKING',
  'BACKPACKING',
  'ROAD_TRIPS',
  'PHOTOGRAPHY',
  'OTHER',
]);
export const CommunityRoleSchema = z.enum(['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER']);
export type CommunityRole = z.infer<typeof CommunityRoleSchema>;
export const MembershipStatusSchema = z.enum(['ACTIVE', 'PENDING', 'LEFT', 'REMOVED', 'BANNED']);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

/** Higher number, more authority. Nobody can act on someone at or above their own rank. */
export const COMMUNITY_ROLE_RANK: Readonly<Record<CommunityRole, number>> = {
  OWNER: 4,
  ADMIN: 3,
  MODERATOR: 2,
  MEMBER: 1,
};

export const CommunitySlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens')
  .min(3)
  .max(60);

const communityFields = {
  name: z.string().trim().min(3).max(100),
  slug: CommunitySlugSchema,
  description: z.string().trim().max(2000).nullable().optional(),
  category: CommunityCategorySchema.optional(),
  /** Null covers both Ride and Travel. */
  mode: TripModeSchema.nullable().optional(),
  visibility: CommunityVisibilitySchema.optional(),
  joinPolicy: CommunityJoinPolicySchema.optional(),
  /** City level only. */
  city: z.string().trim().min(2).max(80).nullable().optional(),
  coverImageId: CommunityCoverIdSchema.nullable().optional(),
};

const privateNeedsApproval = (
  value: { visibility?: string | undefined; joinPolicy?: string | undefined },
  ctx: z.RefinementCtx,
) => {
  if (value.visibility === 'PRIVATE' && value.joinPolicy === 'OPEN') {
    ctx.addIssue({
      code: 'custom',
      path: ['joinPolicy'],
      message: 'Private communities approve each member',
    });
  }
};

export const CreateCommunitySchema = z.object(communityFields).superRefine(privateNeedsApproval);
export type CreateCommunityInput = z.input<typeof CreateCommunitySchema>;
export const UpdateCommunitySchema = z
  .object(communityFields)
  .omit({ slug: true })
  .partial()
  .superRefine(privateNeedsApproval)
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type UpdateCommunityInput = z.input<typeof UpdateCommunitySchema>;

export const CommunitiesQuerySchema = CursorPageQuerySchema.extend({
  q: z.string().trim().min(1).max(80).optional(),
  mode: TripModeSchema.optional(),
  category: CommunityCategorySchema.optional(),
  city: z.string().trim().min(2).max(80).optional(),
  /** Only communities I belong to. */
  mine: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const CommunitySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: CommunityCategorySchema,
  mode: TripModeSchema.nullable(),
  visibility: CommunityVisibilitySchema,
  joinPolicy: CommunityJoinPolicySchema,
  city: z.string().nullable(),
  coverImageUrl: z.string().nullable(),
  memberCount: z.number().int(),
  owner: PersonSummarySchema,
  createdAt: z.string(),
  viewer: z.object({
    role: CommunityRoleSchema.nullable(),
    status: MembershipStatusSchema.nullable(),
    /** Members (or anyone, for public communities) can see trips, posts and members. */
    canSeeContent: z.boolean(),
    actions: z.array(
      z.enum(['join', 'request', 'cancel_request', 'leave', 'edit', 'moderate', 'announce']),
    ),
  }),
});
export type Community = z.infer<typeof CommunitySchema>;

export const JoinCommunitySchema = z.object({ message: z.string().trim().max(500).optional() });
export const CommunityMembersQuerySchema = CursorPageQuerySchema.extend({
  status: z.enum(['ACTIVE', 'PENDING', 'BANNED']).default('ACTIVE'),
});
export const CommunityMemberSchema = z.object({
  user: PersonSummarySchema,
  role: CommunityRoleSchema,
  status: MembershipStatusSchema,
  message: z.string().nullable(),
  joinedAt: z.string(),
});
export type CommunityMember = z.infer<typeof CommunityMemberSchema>;
export const SetCommunityRoleSchema = z.object({ role: z.enum(['ADMIN', 'MODERATOR', 'MEMBER']) });
export const RemoveCommunityMemberSchema = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
  /** Banned members cannot ask to join again. */
  ban: z.boolean().optional(),
});

// ── Posts and feed ──────────────────────────────────────────────────────────

export const PostTypeSchema = z.enum(['TRIP_RECAP', 'PHOTO', 'ANNOUNCEMENT']);
export const PostVisibilitySchema = z.enum(['PUBLIC', 'FOLLOWERS', 'COMMUNITY']);

export const CreatePostSchema = z
  .object({
    type: z.enum(['TRIP_RECAP', 'PHOTO']),
    body: z.string().trim().max(2000).optional(),
    imageIds: z.array(PostPhotoIdSchema).max(6).optional(),
    placeName: z.string().trim().min(2).max(160).optional(),
    /** Required for TRIP_RECAP: a completed trip you were on. */
    tripId: z.uuid().optional(),
    /** Share into a community you belong to. */
    communityId: z.uuid().optional(),
    visibility: PostVisibilitySchema.default('PUBLIC'),
  })
  .superRefine((value, ctx) => {
    if (!value.body && (value.imageIds?.length ?? 0) === 0) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'Write something or add a photo' });
    }
    if (value.type === 'TRIP_RECAP' && !value.tripId) {
      ctx.addIssue({ code: 'custom', path: ['tripId'], message: 'Choose the trip' });
    }
    if (value.visibility === 'COMMUNITY' && !value.communityId) {
      ctx.addIssue({ code: 'custom', path: ['communityId'], message: 'Choose the community' });
    }
  });
export type CreatePostInput = z.input<typeof CreatePostSchema>;

export const CreateAnnouncementSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  /** Members only, or everyone who can see the community. */
  membersOnly: z.boolean().default(false),
});

export const PostSchema = z.object({
  id: z.uuid(),
  type: PostTypeSchema,
  visibility: PostVisibilitySchema,
  body: z.string().nullable(),
  imageUrls: z.array(z.string()),
  placeName: z.string().nullable(),
  author: PersonSummarySchema,
  community: z.object({ slug: z.string(), name: z.string() }).nullable(),
  trip: z.object({ id: z.uuid(), title: z.string() }).nullable(),
  createdAt: z.string(),
  canDelete: z.boolean(),
});
export type Post = z.infer<typeof PostSchema>;

/** A trip in a list (community trips, the feed). Place names only, never coordinates. */
export const TripSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  mode: TripModeSchema,
  status: TripStatusSchema,
  departureAt: z.string(),
  originName: z.string(),
  destinationName: z.string(),
  participantCount: z.number().int(),
  maxParticipants: z.number().int(),
  coverImageUrl: z.string().nullable(),
  organiser: PersonSummarySchema,
  community: z.object({ slug: z.string(), name: z.string() }).nullable(),
});
export type TripSummary = z.infer<typeof TripSummarySchema>;

export const CommunityTripsQuerySchema = CursorPageQuerySchema.extend({
  /** Upcoming (default) or past trips. */
  when: z.enum(['upcoming', 'past']).default('upcoming'),
});

/** Feed items, newest first: posts, and trips when they were published. */
export const FeedItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('post'), at: z.string(), post: PostSchema }),
  z.object({ kind: z.literal('trip'), at: z.string(), trip: TripSummarySchema }),
]);
export type FeedItem = z.infer<typeof FeedItemSchema>;
