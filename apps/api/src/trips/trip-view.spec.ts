import { type AuthUser } from '../common/auth/current-user.decorator.js';
import { allowedActions, canView, type TripRecord } from './trip-view.js';

const organiser: AuthUser = { id: 'o', role: 'USER', sessionFamilyId: 's' };
const member: AuthUser = { id: 'm', role: 'USER', sessionFamilyId: 's' };
const moderator: AuthUser = { id: 'x', role: 'MODERATOR', sessionFamilyId: 's' };
const HOUR = 3_600_000;

const trip = (overrides: Partial<TripRecord> = {}) =>
  ({
    organiserId: 'o',
    status: 'PUBLISHED',
    visibility: 'PUBLIC',
    tripType: 'COMMUNITY_FREE',
    departureAt: new Date(Date.now() + 72 * HOUR),
    ...overrides,
  }) as TripRecord;

const viewer = (user: AuthUser, extra: { isParticipant?: boolean; blocked?: boolean } = {}) => ({
  user,
  isParticipant: false,
  blocked: false,
  ...extra,
});

describe('canView', () => {
  it('applies draft, private and block rules', () => {
    expect(canView(trip({ status: 'DRAFT' }), viewer(member))).toBe(false);
    expect(canView(trip({ status: 'DRAFT' }), viewer(organiser))).toBe(true);
    expect(canView(trip({ visibility: 'PRIVATE' }), viewer(member))).toBe(false);
    expect(canView(trip({ visibility: 'PRIVATE' }), viewer(member, { isParticipant: true }))).toBe(
      true,
    );
    expect(canView(trip(), viewer(member, { blocked: true }))).toBe(false);
    expect(canView(trip({ visibility: 'PRIVATE' }), viewer(moderator))).toBe(true);
  });
});

describe('allowedActions', () => {
  it('offers organisers the actions their trip state allows', () => {
    expect(allowedActions(trip({ status: 'DRAFT' }), organiser)).toEqual([
      'edit',
      'publish',
      'delete',
      'cancel',
    ]);
    expect(allowedActions(trip(), organiser)).toEqual(['edit', 'cancel']);
    expect(allowedActions(trip({ departureAt: new Date(Date.now() + HOUR) }), organiser)).toEqual([
      'edit',
      'start',
      'cancel',
    ]);
    expect(allowedActions(trip({ status: 'IN_PROGRESS' }), organiser)).toEqual([
      'edit',
      'complete',
      'cancel',
    ]);
    expect(allowedActions(trip({ status: 'CANCELLED' }), organiser)).toEqual([]);
  });

  it('gives members nothing, moderators only cancel, and commercial trips nothing', () => {
    expect(allowedActions(trip(), member)).toEqual([]);
    expect(allowedActions(trip(), moderator)).toEqual(['cancel']);
    expect(allowedActions(trip({ tripType: 'COMMERCIAL_PAID' }), organiser)).toEqual([]);
  });
});
