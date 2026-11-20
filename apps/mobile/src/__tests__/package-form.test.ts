import { type OwnPackage } from '@voyago/shared';
import {
  emptyPackageForm,
  formErrors,
  fromOwnPackage,
  type PackageForm,
  paiseToRupees,
  rupeesToPaise,
  toPackageInput,
} from '../commercial/package-form';
import { routeFor } from '../notifications/route';

const future = new Date(Date.now() + 10 * 86_400_000);
const pad = (n: number) => String(n).padStart(2, '0');
const day = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}`;

const validForm = (): PackageForm => ({
  ...emptyPackageForm(),
  title: 'Kudremukh weekend trek',
  destinationName: 'Kudremukh',
  destinationCoords: '13.1317, 75.2654',
  meetingName: 'Mullodi village',
  meetingCoords: '13.1234, 75.2712',
  startsAt: `${day} 06:00`,
  endsAt: `${day} 20:00`,
  priceRupees: '3,499',
  capacity: '12',
  inclusions: 'Permits\n\n  Guide  \n',
  exclusions: '',
  cancellationPolicy: 'Full refund up to 7 days before the start.',
});

describe('package prices', () => {
  it('reads rupees as typed and writes them back', () => {
    expect(rupeesToPaise('3499')).toBe(349_900);
    expect(rupeesToPaise('₹3,499.50')).toBe(349_950);
    expect(rupeesToPaise('3499.555')).toBeNull();
    expect(rupeesToPaise('free')).toBeNull();
    expect(paiseToRupees(349_900)).toBe('3499');
    expect(paiseToRupees(349_950)).toBe('3499.50');
  });
});

describe('toPackageInput', () => {
  it('builds the request from a valid form', () => {
    const result = toPackageInput(validForm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toMatchObject({
      pricePaise: 349_900,
      capacity: 12,
      currency: 'INR',
      inclusions: ['Permits', 'Guide'],
      exclusions: [],
      destination: { name: 'Kudremukh', point: { latitude: 13.1317, longitude: 75.2654 } },
    });
  });

  it('points errors at the fields that show them', () => {
    const result = toPackageInput({ ...validForm(), priceRupees: 'abc', meetingCoords: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(Object.keys(result.errors).sort()).toEqual(['meetingCoords', 'priceRupees']);
    const rules = toPackageInput({
      ...validForm(),
      capacity: '500',
      inclusions: '',
      endsAt: `${day} 05:00`,
    });
    expect(rules.ok).toBe(false);
    if (!rules.ok)
      expect(Object.keys(rules.errors).sort()).toEqual(['capacity', 'endsAt', 'inclusions']);
  });

  it('maps API field paths to form fields', () => {
    expect(
      formErrors({
        'meetingPoint.point.latitude': 'Bad',
        'destination.name': 'Too short',
        pricePaise: 'Too low',
      }),
    ).toEqual({ meetingCoords: 'Bad', destinationName: 'Too short', priceRupees: 'Too low' });
  });

  it('round-trips a saved package', () => {
    const input = toPackageInput(validForm());
    if (!input.ok) throw new Error('invalid');
    const own = {
      ...input.input,
      id: '00000000-0000-4000-8000-000000000001',
      description: null,
      destination: input.input.destination,
      meetingPoint: { ...input.input.meetingPoint, approximate: false },
      photoIds: [],
    } as unknown as OwnPackage;
    expect(toPackageInput(fromOwnPackage(own))).toEqual(input);
  });
});

describe('notification routes for packages', () => {
  it('opens questions for operators and the package for askers', () => {
    expect(routeFor({ packageId: 'p1', screen: 'questions' })).toBe('/operator/questions');
    expect(routeFor({ packageId: 'p1' })).toBe('/packages/p1');
  });
});
