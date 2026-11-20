import {
  type DiscoverySearchQuery,
  type DiscoverySort,
  type GeoPoint,
  type TripMode,
} from '@voyago/shared';

/**
 * Explore filters as the member sets them. `toSearchQuery` turns them into API parameters.
 * Nothing here is stored: no search history is kept on the device or the server.
 */
export type DateWindow = 'any' | 'week' | 'weekend' | 'month';

export type DiscoveryFilters = {
  activityTypes: string[];
  dateWindow: DateWindow;
  maxBudgetRupees: string;
  minSeats: string;
  difficulty: string[];
  bikeCategory: string;
  engineCc: string;
  includeFull: boolean;
  radiusKm: number;
  sort: DiscoverySort;
};

export const RADIUS_OPTIONS = [10, 25, 50, 100, 200] as const;

export const defaultFilters = (): DiscoveryFilters => ({
  activityTypes: [],
  dateWindow: 'any',
  maxBudgetRupees: '',
  minSeats: '',
  difficulty: [],
  bikeCategory: '',
  engineCc: '',
  includeFull: false,
  radiusKm: 25,
  sort: 'relevance',
});

/** How many filters differ from the defaults (shown on the Filters button). */
export function activeFilterCount(filters: DiscoveryFilters): number {
  const base = defaultFilters();
  return [
    filters.activityTypes.length > 0,
    filters.dateWindow !== base.dateWindow,
    filters.maxBudgetRupees.trim() !== '',
    filters.minSeats.trim() !== '',
    filters.difficulty.length > 0,
    filters.bikeCategory !== '',
    filters.engineCc.trim() !== '',
    filters.includeFull,
    filters.radiusKm !== base.radiusKm,
    filters.sort !== base.sort,
  ].filter(Boolean).length;
}

/** Start and end of the chosen date window, in the device's time zone. */
export function dateRange(window: DateWindow, now = new Date()): { from?: string; to?: string } {
  if (window === 'any') return {};
  const end = new Date(now);
  if (window === 'week') end.setDate(end.getDate() + 7);
  if (window === 'month') end.setDate(end.getDate() + 30);
  if (window === 'weekend') {
    // From now until the end of the coming Sunday.
    const daysToSunday = (7 - now.getDay()) % 7;
    end.setDate(end.getDate() + daysToSunday);
    end.setHours(23, 59, 59, 0);
  }
  return { from: now.toISOString(), to: end.toISOString() };
}

const positiveInt = (text: string) => {
  const value = Number(text.trim());
  return text.trim() !== '' && Number.isInteger(value) && value > 0 ? value : undefined;
};

/**
 * Coordinates are rounded to about 100 m before they leave the device: enough for "near me",
 * not enough to pinpoint a home.
 */
export const coarsen = (point: GeoPoint): GeoPoint => ({
  latitude: Math.round(point.latitude * 1000) / 1000,
  longitude: Math.round(point.longitude * 1000) / 1000,
});

export function toSearchQuery(input: {
  text: string;
  mode: TripMode;
  filters: DiscoveryFilters;
  location: GeoPoint | null;
  now?: Date;
}): DiscoverySearchQuery {
  const { filters } = input;
  const dates = dateRange(filters.dateWindow, input.now);
  const budget = positiveInt(filters.maxBudgetRupees);
  const point = input.location ? coarsen(input.location) : null;
  const isRide = input.mode === 'RIDE';
  // Distance sorting needs a location; fall back to relevance without one.
  const sort = filters.sort === 'proximity' && !point ? 'relevance' : filters.sort;
  const query: DiscoverySearchQuery = {
    mode: input.mode,
    sort,
    limit: 20,
    ...(input.text.trim() ? { q: input.text.trim().slice(0, 100) } : {}),
    ...(dates.from ? { departFrom: dates.from, departTo: dates.to } : {}),
    ...(budget !== undefined ? { budgetMaxPaise: budget * 100 } : {}),
    ...(positiveInt(filters.minSeats) !== undefined
      ? { minSeats: positiveInt(filters.minSeats) }
      : {}),
    ...(filters.difficulty.length > 0 ? { difficulty: filters.difficulty.join(',') } : {}),
    ...(filters.includeFull ? { status: 'PUBLISHED,FULL' } : {}),
    ...(point ? { lat: point.latitude, lng: point.longitude, radiusKm: filters.radiusKm } : {}),
  };
  if (!isRide && filters.activityTypes.length > 0) {
    Object.assign(query, { activityType: filters.activityTypes.join(',') });
  }
  if (isRide && filters.bikeCategory) Object.assign(query, { bikeCategory: filters.bikeCategory });
  const cc = positiveInt(filters.engineCc);
  if (isRide && cc !== undefined) Object.assign(query, { engineCc: cc });
  return query;
}

/** Query-string form, skipping empty values. */
export function toQueryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params.toString();
}
