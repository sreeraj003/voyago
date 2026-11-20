import {
  type AppNotification,
  type JoinRequest,
  JoinRequestSchema,
  NotificationSchema,
  pageEnvelope,
  type PageResponse,
  type Participant,
  ParticipantSchema,
  type TripInvitation,
  TripInvitationSchema,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest } from './http';

const RequestPage = pageEnvelope(JoinRequestSchema);
const NotificationPage = pageEnvelope(NotificationSchema);
const InvitationPage = pageEnvelope(TripInvitationSchema);

const page = async <T>(path: string, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await apiRequest(path, { schema: z.unknown(), raw: true }));

export const askToJoin = (tripId: string, message: string): Promise<JoinRequest> =>
  apiRequest(`/trips/${tripId}/join-requests`, {
    method: 'POST',
    body: message.trim() ? { message: message.trim() } : {},
    schema: JoinRequestSchema,
  });

export const withdrawRequest = (id: string): Promise<JoinRequest> =>
  apiRequest(`/join-requests/${id}/withdraw`, { method: 'POST', schema: JoinRequestSchema });

export const approveRequest = (id: string): Promise<JoinRequest> =>
  apiRequest(`/join-requests/${id}/approve`, { method: 'POST', schema: JoinRequestSchema });

export const rejectRequest = (id: string, reason: string): Promise<JoinRequest> =>
  apiRequest(`/join-requests/${id}/reject`, {
    method: 'POST',
    body: reason.trim() ? { reason: reason.trim() } : {},
    schema: JoinRequestSchema,
  });

export const listTripRequests = (
  tripId: string,
  cursor?: string,
): Promise<PageResponse<JoinRequest>> =>
  page(`/trips/${tripId}/join-requests?limit=20${cursor ? `&cursor=${cursor}` : ''}`, RequestPage);

export const listParticipants = (tripId: string): Promise<Participant[]> =>
  apiRequest(`/trips/${tripId}/participants`, { schema: z.array(ParticipantSchema) });

export const removeParticipant = (tripId: string, userId: string, reason: string) =>
  apiRequest(`/trips/${tripId}/participants/${userId}/remove`, {
    method: 'POST',
    body: reason.trim() ? { reason: reason.trim() } : {},
  });

export const leaveTrip = (tripId: string) =>
  apiRequest(`/trips/${tripId}/leave`, { method: 'POST' });

export const listNotifications = (cursor?: string): Promise<PageResponse<AppNotification>> =>
  page(`/me/notifications?limit=20${cursor ? `&cursor=${cursor}` : ''}`, NotificationPage);

export const unreadNotificationCount = async (): Promise<number> =>
  (
    await apiRequest('/me/notifications/unread-count', {
      schema: z.object({ count: z.number() }),
    })
  ).count;

export const markNotificationRead = (id: string) =>
  apiRequest(`/me/notifications/${id}/read`, { method: 'POST' });

export const markAllNotificationsRead = () =>
  apiRequest('/me/notifications/read-all', { method: 'POST', schema: z.unknown() });

export const setParticipantRole = (
  tripId: string,
  userId: string,
  role: 'CO_ORGANISER' | 'PARTICIPANT',
): Promise<Participant[]> =>
  apiRequest(`/trips/${tripId}/participants/${userId}/role`, {
    method: 'POST',
    body: { role },
    schema: z.array(ParticipantSchema),
  });

export const inviteToTrip = (tripId: string, username: string): Promise<TripInvitation> =>
  apiRequest(`/trips/${tripId}/invitations`, {
    method: 'POST',
    body: { username: username.trim().replace(/^@/, '') },
    schema: TripInvitationSchema,
  });

export const listTripInvitations = (tripId: string): Promise<PageResponse<TripInvitation>> =>
  page(`/trips/${tripId}/invitations?limit=50`, InvitationPage);

export const listMyInvitations = (): Promise<PageResponse<TripInvitation>> =>
  page('/me/trip-invitations?limit=50', InvitationPage);

export const respondToInvitation = (
  id: string,
  verb: 'accept' | 'decline' | 'revoke',
): Promise<TripInvitation> =>
  apiRequest(`/trip-invitations/${id}/${verb}`, { method: 'POST', schema: TripInvitationSchema });
