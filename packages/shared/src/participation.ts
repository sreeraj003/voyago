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
  data: z.object({ tripId: z.uuid().optional(), joinRequestId: z.uuid().optional() }),
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
