import { z } from 'zod';
import { CursorPageQuerySchema } from './pagination.js';
import { TripStatusSchema } from './trips.js';

/**
 * Joining community trips. Joining is free: members ask, the organiser approves (or the trip is
 * open and they join at once). Commercial bookings are separate and never use these records.
 */

export const JoinRequestStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
  'CANCELLED',
]);
export type JoinRequestStatus = z.infer<typeof JoinRequestStatusSchema>;

export const ParticipantStatusSchema = z.enum(['ACTIVE', 'COMPLETED', 'LEFT', 'REMOVED']);
export type ParticipantStatus = z.infer<typeof ParticipantStatusSchema>;
export const ParticipantRoleSchema = z.enum(['ORGANISER', 'CO_ORGANISER', 'PARTICIPANT']);

const Reason = z.string().trim().min(3).max(500);

export const CreateJoinRequestSchema = z.object({
  /** A short note to the organiser, e.g. experience or what you ride. */
  message: z.string().trim().max(500).optional(),
});
export type CreateJoinRequestInput = z.input<typeof CreateJoinRequestSchema>;

export const RejectJoinRequestSchema = z.object({ reason: Reason.optional() });
export const RemoveParticipantSchema = z.object({ reason: Reason.optional() });

export const TripJoinRequestsQuerySchema = CursorPageQuerySchema.extend({
  status: JoinRequestStatusSchema.default('PENDING'),
});
export const MyJoinRequestsQuerySchema = CursorPageQuerySchema.extend({
  status: JoinRequestStatusSchema.optional(),
});

const PublicPerson = z.object({ id: z.uuid(), username: z.string(), displayName: z.string() });

export const JoinRequestSchema = z.object({
  id: z.uuid(),
  status: JoinRequestStatusSchema,
  message: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  trip: z.object({
    id: z.uuid(),
    title: z.string(),
    departureAt: z.string(),
    status: TripStatusSchema,
  }),
  requester: PublicPerson,
});
export type JoinRequest = z.infer<typeof JoinRequestSchema>;

export const ParticipantSchema = z.object({
  user: PublicPerson,
  role: ParticipantRoleSchema,
  status: ParticipantStatusSchema,
  joinedAt: z.string(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

/** Organisers make participants co-organisers (and back). */
export const SetParticipantRoleSchema = z.object({ role: z.enum(['CO_ORGANISER', 'PARTICIPANT']) });

// ── Invitations (needed to join PRIVATE trips) ──────────────────────────────

export const TripInvitationStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED']);
export const CreateTripInvitationSchema = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.]{3,30}$/, 'Enter a Voyago username'),
});
export const TripInvitationSchema = z.object({
  id: z.uuid(),
  status: TripInvitationStatusSchema,
  createdAt: z.string(),
  respondedAt: z.string().nullable(),
  trip: z.object({
    id: z.uuid(),
    title: z.string(),
    departureAt: z.string(),
    status: TripStatusSchema,
  }),
  invitee: PublicPerson,
  invitedBy: PublicPerson.nullable(),
});
export type TripInvitation = z.infer<typeof TripInvitationSchema>;
export const MyInvitationsQuerySchema = CursorPageQuerySchema.extend({
  status: TripInvitationStatusSchema.default('PENDING'),
});

// ── Notifications ───────────────────────────────────────────────────────────

export const NotificationTypeSchema = z.enum([
  'JOIN_REQUEST_RECEIVED',
  'JOIN_REQUEST_APPROVED',
  'JOIN_REQUEST_REJECTED',
  'PARTICIPANT_REMOVED',
  'TRIP_UPDATED',
  'TRIP_CANCELLED',
  'TRIP_REMINDER',
  'NEW_MESSAGE',
  'NEW_FOLLOWER',
  'COMMUNITY_INVITE',
  'SAFETY_ALERT',
  'TRIP_INVITE',
  'COMMUNITY_UPDATE',
  'BOOKING_UPDATE',
  'PAYMENT_UPDATE',
  'SYSTEM',
]);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

export const NotificationSchema = z.object({
  id: z.uuid(),
  type: NotificationTypeSchema,
  title: z.string(),
  body: z.string().nullable(),
  /** Ids for navigation only. */
  data: z.object({
    tripId: z.uuid().optional(),
    joinRequestId: z.uuid().optional(),
    invitationId: z.uuid().optional(),
    communitySlug: z.string().optional(),
    username: z.string().optional(),
    conversationId: z.uuid().optional(),
    packageId: z.uuid().optional(),
    bookingId: z.uuid().optional(),
    savedSearchId: z.uuid().optional(),
    /** Which screen to open: a trip's safety page, the operator's questions, or my plan. */
    screen: z.enum(['safety', 'questions', 'subscription']).optional(),
  }),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AppNotification = z.infer<typeof NotificationSchema>;

export const NotificationsQuerySchema = CursorPageQuerySchema.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
