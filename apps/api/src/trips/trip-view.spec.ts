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

  it('lets members join open trips and leave ones they are on', () => {
    const none = { participantStatus: null, hasPendingRequest: false };
    expect(allowedActions(trip(), member)).toEqual(['join']);
    expect(allowedActions(trip(), member, { ...none, hasPendingRequest: true })).toEqual([]);
    expect(allowedActions(trip(), member, { ...none, participantStatus: 'ACTIVE' })).toEqual([
      'leave',
    ]);
    expect(allowedActions(trip(), member, { ...none, participantStatus: 'LEFT' })).toEqual([
      'join',
    ]);
    expect(allowedActions(trip(), member, { ...none, participantStatus: 'REMOVED' })).toEqual([]);
    for (const status of ['FULL', 'IN_PROGRESS', 'CANCELLED', 'EXPIRED', 'COMPLETED'] as const) {
      expect(allowedActions(trip({ status }), member)).not.toContain('join');
    }
    expect(allowedActions(trip({ departureAt: new Date(Date.now() - HOUR) }), member)).toEqual([]);
  });

  it('gives moderators cancel, and commercial trips nothing', () => {
    expect(allowedActions(trip(), moderator)).toEqual(['cancel', 'join']);
    expect(allowedActions(trip({ tripType: 'COMMERCIAL_PAID' }), organiser)).toEqual([]);
    expect(allowedActions(trip({ tripType: 'COMMERCIAL_PAID' }), member)).toEqual([]);
  });
});
