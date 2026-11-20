import {
  changedFields,
  emptyTripForm,
  fromTrip,
  parseCoords,
  parseLocalDateTime,
  toTripInput,
  type TripForm,
} from '../trips/trip-form';

const future = new Date(Date.now() + 3 * 86_400_000);
const pad = (n: number) => String(n).padStart(2, '0');
const day = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}`;

const validForm = (): TripForm => ({
  ...emptyTripForm('RIDE'),
  title: 'Sunrise ride',
  originName: 'Hebbal',
  originCoords: '13.0358, 77.597',
  destinationName: 'Nandi Hills',
  destinationCoords: '13.3702,77.6835',
  departure: `${day} 06:00`,
  maxParticipants: '8',
  budgetRupees: '500',
  durationHours: '5.5',
});

describe('trip form parsing', () => {
  it('parses coordinates and local date-times', () => {
    expect(parseCoords(' 13.03 , 77.59 ')).toEqual({ latitude: 13.03, longitude: 77.59 });
    expect(parseCoords('Hebbal')).toBeNull();
    expect(parseLocalDateTime('2026-02-30 06:00')).toBeNull();
    expect(parseLocalDateTime('2026-11-28 6:30')).toBe(new Date(2026, 10, 28, 6, 30).toISOString());
  });

  it('converts a valid form, including rupees to paise and hours to minutes', () => {
    const result = toTripInput(validForm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toMatchObject({
      estimatedBudgetPaise: 50_000,
      estimatedDurationMinutes: 330,
      origin: { point: { latitude: 13.0358, longitude: 77.597 } },
    });
  });

  it('maps schema errors back to form fields', () => {
    const result = toTripInput({
      ...validForm(),
      title: '',
      originCoords: 'nowhere',
      destinationCoords: '95, 10',
      departure: 'tomorrow',
      minParticipants: '9',
      stops: [{ name: 'X', coords: '1,1', arrival: '' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(
      [
        'departure',
        'destinationCoords',
        'minParticipants',
        'originCoords',
        'stops.0.name',
        'title',
      ].sort(),
    );
  });

  it('sends only changed fields when editing', () => {
    const original = toTripInput(validForm());
    const edited = toTripInput({ ...validForm(), title: 'Renamed' });
    if (!original.ok || !edited.ok) throw new Error('invalid');
    expect(changedFields(original.input, edited.input)).toEqual({ title: 'Renamed' });
  });

  it('round-trips a trip from the API', () => {
    const form = fromTrip({
      mode: 'TRAVEL',
      activityType: 'TREK',
      title: 'Kudremukh trek',
      description: null,
      origin: {
        name: 'Majestic',
        point: { latitude: 12.97, longitude: 77.57 },
        approximate: false,
      },
      destination: { name: 'Kudremukh', point: { latitude: 13.13, longitude: 75.26 } },
      stops: [],
      departureAt: future.toISOString(),
      returnAt: null,
      minParticipants: 2,
      maxParticipants: 10,
      visibility: 'PRIVATE',
      approvalRequired: false,
      estimatedBudgetPaise: 250_000,
      estimatedDistanceKm: null,
      estimatedDurationMinutes: 90,
      difficulty: 'CHALLENGING',
      minEngineCc: null,
    } as unknown as Parameters<typeof fromTrip>[0]);
    expect(form).toMatchObject({
      originCoords: '12.97, 77.57',
      budgetRupees: '2500',
      durationHours: '1.5',
      visibility: 'PRIVATE',
    });
    expect(toTripInput(form).ok).toBe(true);
  });
});
