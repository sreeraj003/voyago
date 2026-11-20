import { z } from 'zod';
import { PhoneSchema } from './auth.js';
import { TRIP_START_WINDOW_MS } from './trips.js';

/**
 * Live location and safety: opt-in, time-limited location sharing with the people on a trip,
 * trip check-ins, emergency contacts and SOS.
 *
 * Privacy: coordinates live only in Redis while a session is active (they expire with it) and on
 * an SOS alert until it is resolved. They are never part of profiles, discovery or any public
 * endpoint, and only the trip's active members can see them.
 */

/** Sharing lasts at most 24 hours; the member chooses how long, from 15 minutes. */
export const LOCATION_SHARE_MAX_MINUTES = 24 * 60;
export const LOCATION_SHARE_CHOICES_MINUTES = [60, 240, 720, 1440] as const;
/** A location older than this is shown as stale. */
export const LOCATION_STALE_AFTER_MS = 2 * 60 * 1000;
/** Updates recorded longer ago than this are refused as stale. */
export const LOCATION_MAX_AGE_MS = 2 * 60 * 1000;
/** At most one update per member per this long is accepted. */
export const LOCATION_MIN_INTERVAL_MS = 3_000;
/** India's single emergency number. Voyago never calls it for you. */
export const EMERGENCY_NUMBER = '112';
export const MAX_EMERGENCY_CONTACTS = 3;

/** How long after departure a trip that was never started still counts as live. */
export const UNSTARTED_TRIP_LIVE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a trip is in its live window: started, or published from two hours before departure
 * until it would expire unstarted. Location sharing works only then.
 */
export function isTripLive(
  trip: { status: string; departureAt: Date | string },
  now = Date.now(),
): boolean {
  if (trip.status === 'IN_PROGRESS') return true;
  if (trip.status !== 'PUBLISHED' && trip.status !== 'FULL') return false;
  // A trip nobody started is expired a day after departure; it stops being live then too.
  const departure = new Date(trip.departureAt).getTime();
  return now >= departure - TRIP_START_WINDOW_MS && now < departure + UNSTARTED_TRIP_LIVE_MS;
}

const Latitude = z.number().min(-90).max(90);
const Longitude = z.number().min(-180).max(180);

export const StartSharingSchema = z.object({
  durationMinutes: z.number().int().min(15).max(LOCATION_SHARE_MAX_MINUTES),
  /** Explicit opt-in: the app shows what is shared and with whom before sending this. */
  consent: z.literal(true, 'Agree to share your location with the people on this trip'),
});
export type StartSharingInput = z.input<typeof StartSharingSchema>;

export const LocationUpdateSchema = z.object({
  latitude: Latitude,
  longitude: Longitude,
  accuracyMeters: z.number().min(0).max(10_000).optional(),
  heading: z.number().min(0).max(360).optional(),
  speedMps: z.number().min(0).max(150).optional(),
  /** When the device took the reading (ISO time). */
  recordedAt: z.iso.datetime({ offset: true }),
});
export type LocationUpdateInput = z.input<typeof LocationUpdateSchema>;
export const SocketLocationUpdateSchema = LocationUpdateSchema.extend({ tripId: z.uuid() });

export const SafetyPersonSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
});
export type SafetyPerson = z.infer<typeof SafetyPersonSchema>;

export const LocationPointSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  accuracyMeters: z.number().nullable(),
  heading: z.number().nullable(),
  speedMps: z.number().nullable(),
  recordedAt: z.string(),
});
export type LocationPoint = z.infer<typeof LocationPointSchema>;

export const LocationSessionStatusSchema = z.enum(['ACTIVE', 'ENDED', 'EXPIRED']);
export const LocationSessionSchema = z.object({
  id: z.uuid(),
  tripId: z.uuid(),
  status: LocationSessionStatusSchema,
  startedAt: z.string(),
  expiresAt: z.string(),
  endedAt: z.string().nullable(),
});
export type LocationSession = z.infer<typeof LocationSessionSchema>;

/** A member sharing their location, with their latest point (null until the first update). */
export const SharerSchema = z.object({
  user: SafetyPersonSchema,
  expiresAt: z.string(),
  location: LocationPointSchema.nullable(),
});
export type Sharer = z.infer<typeof SharerSchema>;

export const CheckInKindSchema = z.enum(['AT_START', 'ALL_GOOD', 'ARRIVED_SAFELY']);
export type CheckInKind = z.infer<typeof CheckInKindSchema>;
export const CreateCheckInSchema = z.object({
  kind: CheckInKindSchema,
  note: z.string().trim().max(200).optional(),
});
export type CreateCheckInInput = z.input<typeof CreateCheckInSchema>;
export const CheckInSchema = z.object({
  id: z.uuid(),
  user: SafetyPersonSchema,
  kind: CheckInKindSchema,
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type CheckIn = z.infer<typeof CheckInSchema>;

export const SosStatusSchema = z.enum(['ACTIVE', 'RESOLVED', 'CANCELLED']);
export const SosAlertSchema = z.object({
  id: z.uuid(),
  tripId: z.uuid(),
  user: SafetyPersonSchema,
  status: SosStatusSchema,
  message: z.string().nullable(),
  /** The last known location when the alert was raised; cleared once it is resolved. */
  location: z
    .object({ latitude: z.number(), longitude: z.number(), recordedAt: z.string() })
    .nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: SafetyPersonSchema.nullable(),
});
export type SosAlert = z.infer<typeof SosAlertSchema>;

export const RaiseSosSchema = z.object({
  /** The app asks "Send SOS?" first; the request must say it was confirmed. */
  confirm: z.literal(true, 'Confirm the SOS'),
  message: z.string().trim().max(300).optional(),
  /** The device's current position, if it has one; otherwise the last shared location is used. */
  location: z
    .object({
      latitude: Latitude,
      longitude: Longitude,
      recordedAt: z.iso.datetime({ offset: true }),
    })
    .optional(),
});
export type RaiseSosInput = z.input<typeof RaiseSosSchema>;

export const SosResultSchema = z.object({
  alert: SosAlertSchema,
  /** Trip members told in the app (and by push when it is set up). */
  membersNotified: z.number().int(),
  /** Emergency contacts texted. Zero when SMS is not set up on the server. */
  contactsTexted: z.number().int(),
  contactsTotal: z.number().int(),
  smsAvailable: z.boolean(),
  emergencyNumber: z.string(),
});
export type SosResult = z.infer<typeof SosResultSchema>;

export const ResolveSosSchema = z.object({ outcome: z.enum(['SAFE', 'FALSE_ALARM']) });
export type ResolveSosInput = z.input<typeof ResolveSosSchema>;

/** Everything the trip's safety screen needs, for an active member. */
export const TripSafetySchema = z.object({
  tripId: z.uuid(),
  live: z.boolean(),
  mySession: LocationSessionSchema.nullable(),
  sharers: z.array(SharerSchema),
  checkIns: z.array(CheckInSchema),
  alerts: z.array(SosAlertSchema),
  emergencyNumber: z.string(),
  /** False when the server cannot text emergency contacts (no SMS provider). */
  smsAvailable: z.boolean(),
});
export type TripSafety = z.infer<typeof TripSafetySchema>;

// ── Emergency contacts (private to their owner) ─────────────────────────────

export const EmergencyContactSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  phone: z.string(),
  relationship: z.string().nullable(),
  createdAt: z.string(),
});
export type EmergencyContact = z.infer<typeof EmergencyContactSchema>;
export const CreateEmergencyContactSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: PhoneSchema,
  relationship: z.string().trim().max(40).optional(),
});
export type CreateEmergencyContactInput = z.input<typeof CreateEmergencyContactSchema>;

// ── Socket events ───────────────────────────────────────────────────────────

export interface LocationServerEvents {
  'location:update': (
    event: { tripId: string; user: SafetyPerson; expiresAt: string } & LocationPoint,
  ) => void;
  'location:stopped': (event: { tripId: string; userId: string }) => void;
  'sos:raised': (event: SosAlert) => void;
  'sos:resolved': (event: SosAlert) => void;
}
