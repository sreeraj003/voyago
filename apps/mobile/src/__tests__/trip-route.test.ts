import { type Trip } from '@voyago/shared';
import { directionsUrl, formatDistance, formatDuration, routeSummary } from '../trips/trip-route';

const trip = (overrides: Partial<Trip>): Trip =>
  ({
    origin: { name: 'Hebbal', point: { latitude: 13.0358, longitude: 77.597 }, approximate: false },
    destination: { name: 'Nandi Hills', point: { latitude: 13.3702, longitude: 77.6835 } },
    stops: [],
    route: null,
    ...overrides,
  }) as Trip;

describe('trip route display', () => {
  it('formats distance and duration', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(6_420)).toBe('6.4 km');
    expect(formatDistance(61_800)).toBe('62 km');
    expect(formatDuration(40 * 60)).toBe('40 min');
    expect(formatDuration(2 * 3600)).toBe('2 h');
    expect(formatDuration(3 * 3600 + 25 * 60)).toBe('3 h 25 min');
  });

  it('only describes a route that Google supplied', () => {
    expect(routeSummary(trip({}))).toBeNull();
    expect(
      routeSummary(
        trip({
          route: {
            distanceMeters: 61_800,
            durationSeconds: 5_400,
            travelMode: 'TWO_WHEELER',
            source: 'GOOGLE',
            computedAt: new Date().toISOString(),
          },
        }),
      ),
    ).toBe('62 km, about 1 h 30 min by two-wheeler (Google Maps)');
  });

  it('builds a directions link and leaves out a hidden meeting point', () => {
    const url = new URL(directionsUrl(trip({}))!);
    expect(url.searchParams.get('origin')).toBe('13.0358,77.597');
    expect(url.searchParams.get('destination')).toBe('13.3702,77.6835');

    const hidden = new URL(
      directionsUrl(
        trip({
          origin: {
            name: 'Hebbal',
            point: { latitude: 13.04, longitude: 77.6 },
            approximate: true,
          },
          stops: [
            {
              id: '0e6f7a52-6c6f-4f0b-9a55-0c1d2e3f4a5b',
              position: 0,
              name: 'Devanahalli',
              point: { latitude: 13.2437, longitude: 77.7172 },
              plannedArrivalAt: null,
              notes: null,
            },
          ],
        }),
      )!,
    );
    expect(hidden.searchParams.has('origin')).toBe(false);
    expect(hidden.searchParams.get('waypoints')).toBe('13.2437,77.7172');
  });
});
