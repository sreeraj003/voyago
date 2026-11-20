/** Display names for enum values shown in several screens. */
export const TRAVEL_ACTIVITY_OPTIONS = [
  { value: 'ROAD_TRIP', label: 'Road trip' },
  { value: 'BACKPACKING', label: 'Backpacking' },
  { value: 'TREK', label: 'Trek' },
  { value: 'WEEKEND_GETAWAY', label: 'Weekend getaway' },
  { value: 'OTHER', label: 'Other' },
] as const;

export const BIKE_CATEGORY_OPTIONS = [
  { value: 'STREET', label: 'Street' },
  { value: 'SPORT', label: 'Sport' },
  { value: 'CRUISER', label: 'Cruiser' },
  { value: 'TOURER', label: 'Tourer' },
  { value: 'ADVENTURE', label: 'Adventure' },
  { value: 'OFF_ROAD', label: 'Off-road' },
  { value: 'SCOOTER', label: 'Scooter' },
  { value: 'OTHER', label: 'Other' },
] as const;

export const DIFFICULTY_OPTIONS = [
  { value: 'EASY', label: 'Easy' },
  { value: 'MODERATE', label: 'Moderate' },
  { value: 'CHALLENGING', label: 'Challenging' },
] as const;

export const COMMUNITY_CATEGORY_OPTIONS = [
  { value: 'RIDING_CLUB', label: 'Riding club' },
  { value: 'TOURING', label: 'Touring' },
  { value: 'TREKKING', label: 'Trekking' },
  { value: 'BACKPACKING', label: 'Backpacking' },
  { value: 'ROAD_TRIPS', label: 'Road trips' },
  { value: 'PHOTOGRAPHY', label: 'Photography' },
  { value: 'OTHER', label: 'Other' },
] as const;

export const REPORT_REASON_OPTIONS = [
  { value: 'HARASSMENT', label: 'Harassment' },
  { value: 'SPAM', label: 'Spam' },
  { value: 'FAKE_PROFILE', label: 'Fake profile' },
  { value: 'UNSAFE_BEHAVIOUR', label: 'Unsafe behaviour' },
  { value: 'INAPPROPRIATE_CONTENT', label: 'Inappropriate content' },
  { value: 'SCAM_OR_FRAUD', label: 'Scam or fraud' },
  { value: 'ILLEGAL_TRANSPORT', label: 'Paid rides or illegal transport' },
  { value: 'OTHER', label: 'Something else' },
] as const;

export const COMMUNITY_ROLE_LABELS = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MODERATOR: 'Moderator',
  MEMBER: 'Member',
} as const;

const ALL: Record<string, string> = Object.fromEntries(
  [
    ...TRAVEL_ACTIVITY_OPTIONS,
    ...BIKE_CATEGORY_OPTIONS,
    ...DIFFICULTY_OPTIONS,
    ...COMMUNITY_CATEGORY_OPTIONS,
  ].map((o) => [o.value, o.label]),
);
export const labelFor = (value: string) =>
  value === 'MOTORCYCLE_RIDE' ? 'Motorcycle ride' : (ALL[value] ?? value);
