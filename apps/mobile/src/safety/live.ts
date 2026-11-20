import {
  LOCATION_STALE_AFTER_MS,
  type LocationServerEvents,
  type SosAlert,
  type TripSafety,
} from '@voyago/shared';

type LocationEvent = Parameters<LocationServerEvents['location:update']>[0];

/** The safety state with one member's newest reading in it. */
export function withLocation(state: TripSafety | undefined, event: LocationEvent) {
  if (!state || state.tripId !== event.tripId) return state;
  const { user, expiresAt } = event;
  const location = {
    latitude: event.latitude,
    longitude: event.longitude,
    accuracyMeters: event.accuracyMeters,
    heading: event.heading,
    speedMps: event.speedMps,
    recordedAt: event.recordedAt,
  };
  const existing = state.sharers.find((s) => s.user.id === user.id);
  if (existing?.location && existing.location.recordedAt >= location.recordedAt) return state;
  const sharer = { user, expiresAt, location };
  return {
    ...state,
    sharers: existing
      ? state.sharers.map((s) => (s.user.id === user.id ? sharer : s))
      : [...state.sharers, sharer],
  };
}

export function withoutSharer(state: TripSafety | undefined, tripId: string, userId: string) {
  if (!state || state.tripId !== tripId) return state;
  return { ...state, sharers: state.sharers.filter((s) => s.user.id !== userId) };
}

/** Adds a new alert, or replaces it when it was resolved. */
export function withAlert(state: TripSafety | undefined, alert: SosAlert) {
  if (!state || state.tripId !== alert.tripId) return state;
  const others = state.alerts.filter((a) => a.id !== alert.id);
  return {
    ...state,
    alerts: [alert, ...others].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

/** "Updated 40 s ago", and whether the reading is old enough to doubt. */
export function freshness(recordedAt: string, now = Date.now()) {
  const age = Math.max(0, now - new Date(recordedAt).getTime());
  const seconds = Math.round(age / 1000);
  const label =
    seconds < 60
      ? `Updated ${seconds} s ago`
      : seconds < 3600
        ? `Updated ${Math.floor(seconds / 60)} min ago`
        : `Updated ${Math.floor(seconds / 3600)} h ago`;
  return { label, stale: age > LOCATION_STALE_AFTER_MS };
}

/** "45 min left", "3 h 10 min left". */
export function timeLeft(expiresAt: string, now = Date.now()) {
  const minutes = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 60_000));
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min left` : `${hours} h left`;
}

export function durationLabel(minutes: number) {
  return minutes < 60 ? `${minutes} min` : `${minutes / 60} h`;
}

export function mapsLink(point: { latitude: number; longitude: number }) {
  return `https://maps.google.com/?q=${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;
}
