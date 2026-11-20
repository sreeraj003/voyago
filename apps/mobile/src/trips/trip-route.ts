import { type GeoPoint, type Trip } from '@voyago/shared';

/** "142 km" or "850 m". */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km < 10 ? Math.round(km * 10) / 10 : Math.round(km)} km`;
}

/** "3 h 25 min" or "40 min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Google's route summary for the trip, labelled with where it came from. */
export function routeSummary(trip: Trip): string | null {
  if (!trip.route) return null;
  const vehicle = trip.route.travelMode === 'TWO_WHEELER' ? 'two-wheeler' : 'car';
  return `${formatDistance(trip.route.distanceMeters)}, about ${formatDuration(
    trip.route.durationSeconds,
  )} by ${vehicle} (Google Maps)`;
}

const latLng = (point: GeoPoint) => `${point.latitude},${point.longitude}`;

/**
 * Google Maps directions link (the public URL scheme, no key needed). The meeting point is only
 * included when the viewer can see the exact spot; otherwise Maps starts from their location.
 */
export function directionsUrl(trip: Trip): string | null {
  if (!trip.destination.point) return null;
  const params = new URLSearchParams({ api: '1', destination: latLng(trip.destination.point) });
  if (trip.origin.point && !trip.origin.approximate)
    params.set('origin', latLng(trip.origin.point));
  if (trip.stops.length > 0) {
    params.set('waypoints', trip.stops.map((stop) => latLng(stop.point)).join('|'));
  }
  params.set('travelmode', 'driving');
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
