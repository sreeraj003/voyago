import {
  type AppNotification,
  type JoinRequest,
  JoinRequestSchema,
  NotificationSchema,
  pageEnvelope,
  type PageResponse,
  type Participant,
  ParticipantSchema,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest } from './http';

const RequestPage = pageEnvelope(JoinRequestSchema);
const NotificationPage = pageEnvelope(NotificationSchema);

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
