import {
  type CheckIn,
  CheckInSchema,
  type CreateCheckInInput,
  type CreateEmergencyContactInput,
  type EmergencyContact,
  EmergencyContactSchema,
  type LocationSession,
  LocationSessionSchema,
  type LocationUpdateInput,
  type RaiseSosInput,
  type SosAlert,
  SosAlertSchema,
  type SosResult,
  SosResultSchema,
  type TripSafety,
  TripSafetySchema,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest } from './http';

export const safetyKey = (tripId: string) => ['trip-safety', tripId] as const;

export const getSafety = (tripId: string): Promise<TripSafety> =>
  apiRequest(`/trips/${tripId}/safety`, { schema: TripSafetySchema });

export const startSharing = (tripId: string, durationMinutes: number): Promise<LocationSession> =>
  apiRequest(`/trips/${tripId}/location/share`, {
    method: 'POST',
    body: { durationMinutes, consent: true },
    schema: LocationSessionSchema,
  });

export const stopSharing = (tripId: string) =>
  apiRequest(`/trips/${tripId}/location/stop`, { method: 'POST' });

/** The REST fallback for one reading, used when the socket is not connected. */
export const sendLocation = (tripId: string, reading: LocationUpdateInput) =>
  apiRequest(`/trips/${tripId}/location`, {
    method: 'POST',
    body: reading,
    schema: z.object({ accepted: z.boolean() }),
  });

export const checkIn = (tripId: string, input: CreateCheckInInput): Promise<CheckIn> =>
  apiRequest(`/trips/${tripId}/check-ins`, { method: 'POST', body: input, schema: CheckInSchema });

export const raiseSos = (
  tripId: string,
  input: Omit<RaiseSosInput, 'confirm'>,
): Promise<SosResult> =>
  apiRequest(`/trips/${tripId}/sos`, {
    method: 'POST',
    body: { ...input, confirm: true },
    schema: SosResultSchema,
  });

export const resolveSos = (alertId: string, outcome: 'SAFE' | 'FALSE_ALARM'): Promise<SosAlert> =>
  apiRequest(`/sos/${alertId}/resolve`, {
    method: 'POST',
    body: { outcome },
    schema: SosAlertSchema,
  });

export const listContacts = (): Promise<EmergencyContact[]> =>
  apiRequest('/me/emergency-contacts', { schema: z.array(EmergencyContactSchema) });

export const addContact = (input: CreateEmergencyContactInput): Promise<EmergencyContact> =>
  apiRequest('/me/emergency-contacts', {
    method: 'POST',
    body: input,
    schema: EmergencyContactSchema,
  });

export const removeContact = (id: string) =>
  apiRequest(`/me/emergency-contacts/${id}`, { method: 'DELETE' });
