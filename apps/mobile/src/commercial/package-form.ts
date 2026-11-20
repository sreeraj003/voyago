import {
  CreatePackageSchema,
  type CreatePackageInput,
  type OperatorCategory,
  type OwnPackage,
} from '@voyago/shared';
import {
  formatCoords,
  formatLocalDateTime,
  parseCoords,
  parseLocalDateTime,
} from '../trips/trip-form';

/** What the package form edits: text as typed, converted on save. */
export type PackageForm = {
  mode: 'RIDE' | 'TRAVEL';
  activityType: CreatePackageInput['activityType'];
  title: string;
  description: string;
  destinationName: string;
  destinationCoords: string;
  meetingName: string;
  meetingCoords: string;
  /** "YYYY-MM-DD HH:MM" local time. */
  startsAt: string;
  endsAt: string;
  /** Rupees per person, including taxes, e.g. "3499" or "3499.50". */
  priceRupees: string;
  capacity: string;
  /** One item per line. */
  inclusions: string;
  exclusions: string;
  cancellationPolicy: string;
  photoIds: string[];
};

export const emptyPackageForm = (): PackageForm => ({
  mode: 'TRAVEL',
  activityType: 'TREK',
  title: '',
  description: '',
  destinationName: '',
  destinationCoords: '',
  meetingName: '',
  meetingCoords: '',
  startsAt: '',
  endsAt: '',
  priceRupees: '',
  capacity: '',
  inclusions: '',
  exclusions: '',
  cancellationPolicy: '',
  photoIds: [],
});

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** "3,499.50" → 349950 paise; null when it isn't a price. */
export function rupeesToPaise(text: string): number | null {
  const clean = text.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export const paiseToRupees = (paise: number) =>
  paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);

/** Maps a schema path to the form field that shows its error. */
function fieldFor(path: PropertyKey[]): string {
  const [head, child] = path.map(String);
  if (head === 'destination') return child === 'name' ? 'destinationName' : 'destinationCoords';
  if (head === 'meetingPoint') return child === 'name' ? 'meetingName' : 'meetingCoords';
  if (head === 'pricePaise') return 'priceRupees';
  return head ?? 'form';
}

/** API field errors ("destination.point.latitude") keyed by the form fields that show them. */
export function formErrors(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(fields)) {
    out[fieldFor(path.split('.'))] ??= message;
  }
  return out;
}

export type PackageFormResult =
  { ok: true; input: CreatePackageInput } | { ok: false; errors: Record<string, string> };

/** Checks the form with the same rules as the API and builds the request body. */
export function toPackageInput(form: PackageForm): PackageFormResult {
  const errors: Record<string, string> = {};
  const destination = parseCoords(form.destinationCoords);
  const meeting = parseCoords(form.meetingCoords);
  const startsAt = parseLocalDateTime(form.startsAt);
  const endsAt = parseLocalDateTime(form.endsAt);
  const pricePaise = rupeesToPaise(form.priceRupees);
  const capacity = /^\d+$/.test(form.capacity.trim()) ? Number(form.capacity.trim()) : null;
  if (!destination) errors.destinationCoords = 'Pick the place or enter "latitude, longitude"';
  if (!meeting) errors.meetingCoords = 'Pick the place or enter "latitude, longitude"';
  if (!startsAt) errors.startsAt = 'Choose the start date and time';
  if (!endsAt) errors.endsAt = 'Choose the end date and time';
  if (pricePaise === null) errors.priceRupees = 'Enter the price in rupees, like 3499';
  if (capacity === null) errors.capacity = 'Enter how many people can join';
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const input = {
    mode: form.mode,
    activityType: form.activityType,
    title: form.title.trim(),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    destination: { name: form.destinationName.trim(), point: destination! },
    meetingPoint: { name: form.meetingName.trim(), point: meeting! },
    startsAt: startsAt!,
    endsAt: endsAt!,
    pricePaise: pricePaise!,
    currency: 'INR' as const,
    capacity: capacity!,
    inclusions: lines(form.inclusions),
    exclusions: lines(form.exclusions),
    cancellationPolicy: form.cancellationPolicy.trim(),
    photoIds: form.photoIds,
  };
  const parsed = CreatePackageSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldFor(issue.path);
      errors[field] ??= issue.message;
    }
    return { ok: false, errors };
  }
  return { ok: true, input };
}

export function fromOwnPackage(pkg: OwnPackage): PackageForm {
  return {
    mode: pkg.mode,
    activityType: pkg.activityType,
    title: pkg.title,
    description: pkg.description ?? '',
    destinationName: pkg.destination.name,
    destinationCoords: formatCoords(pkg.destination.point),
    meetingName: pkg.meetingPoint.name,
    meetingCoords: formatCoords(pkg.meetingPoint.point),
    startsAt: formatLocalDateTime(pkg.startsAt),
    endsAt: formatLocalDateTime(pkg.endsAt),
    priceRupees: paiseToRupees(pkg.pricePaise),
    capacity: String(pkg.capacity),
    inclusions: pkg.inclusions.join('\n'),
    exclusions: pkg.exclusions.join('\n'),
    cancellationPolicy: pkg.cancellationPolicy,
    photoIds: pkg.photoIds,
  };
}

export const OPERATOR_CATEGORY_OPTIONS: readonly { value: OperatorCategory; label: string }[] = [
  { value: 'TREKKING', label: 'Trekking' },
  { value: 'GUIDED_RIDES', label: 'Guided rides' },
  { value: 'TOUR_OPERATOR', label: 'Tour operator' },
  { value: 'ADVENTURE_ACTIVITIES', label: 'Adventure activities' },
  { value: 'CAMPING_AND_STAYS', label: 'Camping and stays' },
  { value: 'OTHER', label: 'Other' },
];

export const categoryLabel = (value: OperatorCategory) =>
  OPERATOR_CATEGORY_OPTIONS.find((o) => o.value === value)?.label ?? value;

export const PACKAGE_STATUS_LABELS: Record<OwnPackage['status'], string> = {
  DRAFT: 'Draft',
  PENDING_REVIEW: 'In review',
  PUBLISHED: 'Published',
  SUSPENDED: 'Suspended by Voyago',
  ARCHIVED: 'Archived',
};

/** "Sat 5 Dec, 6:00 am – Sun 6 Dec, 6:00 pm" in the device's time zone. */
export function packageDates(startsAt: string, endsAt: string): string {
  const day = (iso: string) =>
    new Date(iso).toLocaleString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  return `${day(startsAt)} – ${day(endsAt)}`;
}
