import {
  CreateTripSchema,
  type CreateTripInput,
  type GeoPoint,
  type Trip,
  type TripStopInput,
} from '@voyago/shared';

/**
 * Form state for creating and editing a trip. Inputs are strings; `toTripInput` converts and
 * validates them with the same shared schema the API uses, so errors match the server's.
 *
 * Places hold a name plus "latitude, longitude": filled by Google place search when the server
 * has it configured, or typed by hand. Dates are "YYYY-MM-DD HH:MM" in the device's time zone,
 * set by the native date-time picker.
 */
export type StopForm = { name: string; coords: string; arrival: string };

export type TripForm = {
  mode: 'RIDE' | 'TRAVEL';
  activityType: CreateTripInput['activityType'];
  title: string;
  description: string;
  originName: string;
  originCoords: string;
  destinationName: string;
  destinationCoords: string;
  stops: StopForm[];
  departure: string;
  returnAt: string;
  minParticipants: string;
  maxParticipants: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  approvalRequired: boolean;
  budgetRupees: string;
  distanceKm: string;
  durationHours: string;
  difficulty: '' | 'EASY' | 'MODERATE' | 'CHALLENGING';
  minEngineCc: string;
  /** Uploaded cover id. `undefined` leaves the cover unchanged, `null` removes it. */
  coverImageId?: string | null;
  /** Local or delivered URL used only for the preview. */
  coverPreview: string | null;
};

export const emptyTripForm = (mode: 'RIDE' | 'TRAVEL' = 'RIDE'): TripForm => ({
  mode,
  activityType: mode === 'RIDE' ? 'MOTORCYCLE_RIDE' : 'WEEKEND_GETAWAY',
  title: '',
  description: '',
  originName: '',
  originCoords: '',
  destinationName: '',
  destinationCoords: '',
  stops: [],
  departure: '',
  returnAt: '',
  minParticipants: '1',
  maxParticipants: '6',
  visibility: 'PUBLIC',
  approvalRequired: true,
  budgetRupees: '',
  distanceKm: '',
  durationHours: '',
  difficulty: '',
  minEngineCc: '',
  coverPreview: null,
});

export function parseCoords(text: string): GeoPoint | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  return { latitude: Number(match[1]), longitude: Number(match[2]) };
}

export const formatCoords = (point: GeoPoint | null) =>
  point ? `${point.latitude}, ${point.longitude}` : '';

/** "2026-11-28 06:30" in local time → ISO string, or null if malformed. */
export function parseLocalDateTime(text: string): string | null {
  const match = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(year, month - 1, day, hour, minute);
  if (date.getMonth() !== month - 1 || date.getDate() !== day || hour > 23) return null;
  return date.toISOString();
}

export function formatLocalDateTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const optionalInt = (text: string) => (text.trim() === '' ? null : Number(text.trim()));

/** Maps a schema path such as `origin.point.latitude` to the form field that holds it. */
function fieldFor(path: PropertyKey[]): string {
  const [head, index, child] = path.map(String);
  if (head === 'origin' || head === 'destination')
    return `${head}${index === 'name' ? 'Name' : 'Coords'}`;
  if (head === 'stops' && index !== undefined) {
    return `stops.${index}.${child === 'name' ? 'name' : child === 'plannedArrivalAt' ? 'arrival' : 'coords'}`;
  }
  const renamed: Record<string, string> = {
    departureAt: 'departure',
    estimatedBudgetPaise: 'budgetRupees',
    estimatedDistanceKm: 'distanceKm',
    estimatedDurationMinutes: 'durationHours',
  };
  return renamed[head ?? ''] ?? head ?? 'form';
}

export type FormResult =
  { ok: true; input: CreateTripInput } | { ok: false; errors: Record<string, string> };

export function toTripInput(form: TripForm): FormResult {
  const errors: Record<string, string> = {};
  const point = (text: string, field: string) => {
    const parsed = parseCoords(text);
    if (!parsed) {
      errors[field] =
        text.trim() === ''
          ? 'Choose a place or enter its coordinates'
          : 'Enter "latitude, longitude", e.g. 13.0358, 77.5970';
    }
    return parsed ?? { latitude: 0, longitude: 0 };
  };
  const date = (text: string, field: string, required: boolean) => {
    if (!required && text.trim() === '') return null;
    const parsed = parseLocalDateTime(text);
    if (!parsed) {
      errors[field] =
        text.trim() === '' ? 'Choose a date and time' : 'Use the format YYYY-MM-DD HH:MM';
    }
    return parsed ?? new Date(0).toISOString();
  };

  const stops: TripStopInput[] = form.stops.map((stop, index) => ({
    name: stop.name,
    point: point(stop.coords, `stops.${index}.coords`),
    plannedArrivalAt: date(stop.arrival, `stops.${index}.arrival`, false),
  }));
  const budget = optionalInt(form.budgetRupees);
  const hours = form.durationHours.trim() === '' ? null : Number(form.durationHours);

  const candidate = {
    mode: form.mode,
    activityType: form.activityType,
    title: form.title,
    description: form.description.trim() || null,
    origin: { name: form.originName, point: point(form.originCoords, 'originCoords') },
    destination: {
      name: form.destinationName,
      point: point(form.destinationCoords, 'destinationCoords'),
    },
    stops,
    departureAt: date(form.departure, 'departure', true) ?? '',
    returnAt: date(form.returnAt, 'returnAt', false),
    minParticipants: Number(form.minParticipants),
    maxParticipants: Number(form.maxParticipants),
    estimatedBudgetPaise: budget === null ? null : Math.round(budget * 100),
    estimatedDistanceKm: optionalInt(form.distanceKm),
    estimatedDurationMinutes: hours === null ? null : Math.round(hours * 60),
    difficulty: form.difficulty || null,
    minEngineCc: form.mode === 'RIDE' ? optionalInt(form.minEngineCc) : null,
    visibility: form.visibility,
    approvalRequired: form.approvalRequired,
    ...(form.coverImageId === undefined ? {} : { coverImageId: form.coverImageId }),
  };

  const parsed = CreateTripSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldFor(issue.path);
      errors[field] ??= issue.message;
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, input: candidate };
}

export function fromTrip(trip: Trip): TripForm {
  const rupees = trip.estimatedBudgetPaise === null ? '' : String(trip.estimatedBudgetPaise / 100);
  return {
    mode: trip.mode,
    activityType: trip.activityType,
    title: trip.title,
    description: trip.description ?? '',
    originName: trip.origin.name,
    originCoords: formatCoords(trip.origin.point),
    destinationName: trip.destination.name,
    destinationCoords: formatCoords(trip.destination.point),
    stops: trip.stops.map((stop) => ({
      name: stop.name,
      coords: formatCoords(stop.point),
      arrival: formatLocalDateTime(stop.plannedArrivalAt),
    })),
    departure: formatLocalDateTime(trip.departureAt),
    returnAt: formatLocalDateTime(trip.returnAt),
    minParticipants: String(trip.minParticipants),
    maxParticipants: String(trip.maxParticipants),
    visibility: trip.visibility === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC',
    approvalRequired: trip.approvalRequired,
    budgetRupees: rupees,
    distanceKm: trip.estimatedDistanceKm === null ? '' : String(trip.estimatedDistanceKm),
    durationHours:
      trip.estimatedDurationMinutes === null
        ? ''
        : String(Math.round((trip.estimatedDurationMinutes / 60) * 10) / 10),
    difficulty: trip.difficulty ?? '',
    minEngineCc: trip.minEngineCc === null ? '' : String(trip.minEngineCc),
    coverPreview: trip.coverImageUrl,
  };
}

/** Only the fields that changed, so edits after publishing don't touch locked fields. */
export function changedFields(
  original: CreateTripInput,
  next: CreateTripInput,
): Partial<CreateTripInput> {
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof CreateTripInput)[]) {
    if (JSON.stringify(original[key] ?? null) !== JSON.stringify(next[key] ?? null)) {
      changes[key] = next[key];
    }
  }
  return changes;
}

export const formatRupees = (paise: number | null) =>
  paise === null ? null : `₹${(paise / 100).toLocaleString('en-IN')}`;
