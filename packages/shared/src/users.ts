import { z } from 'zod';
import { DisplayNameSchema, UsernameSchema } from './auth.js';
import { FollowStateSchema } from './social.js';
import { TripModeSchema } from './trip-mode.js';

/**
 * Profile, preference and motorcycle contracts.
 *
 * Privacy: email and phone appear only in the signed-in member's own profile (`/me`). Public
 * profiles never include contact details, exact locations, vehicle identifiers or documents.
 */

/** USER is a member; the other roles are Voyago staff (see admin.ts for what each may do). */
export const UserRoleSchema = z.enum(['USER', 'SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'OPERATIONS']);
export type UserRole = z.infer<typeof UserRoleSchema>;
export const UserStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']);
export const ProfileVisibilitySchema = z.enum(['PUBLIC', 'FOLLOWERS', 'PRIVATE']);
export const MessagePermissionSchema = z.enum([
  'EVERYONE',
  'FOLLOWERS',
  'TRIP_PARTICIPANTS',
  'NOBODY',
]);
export const ActivityTypeSchema = z.enum([
  'MOTORCYCLE_RIDE',
  'ROAD_TRIP',
  'BACKPACKING',
  'TREK',
  'WEEKEND_GETAWAY',
  'OTHER',
]);
export const TravelStyleSchema = z.enum([
  'BUDGET',
  'COMFORT',
  'LUXURY',
  'ADVENTURE',
  'RELAXED',
  'CULTURAL',
  'NATURE',
  'SOCIAL',
]);
export const RidingExperienceSchema = z.enum(['BEGINNER', 'INTERMEDIATE', 'EXPERIENCED', 'EXPERT']);
export const MotorcycleCategorySchema = z.enum([
  'STREET',
  'SPORT',
  'CRUISER',
  'TOURER',
  'ADVENTURE',
  'OFF_ROAD',
  'SCOOTER',
  'OTHER',
]);
export type MotorcycleCategory = z.infer<typeof MotorcycleCategorySchema>;
export const VehicleVerificationStatusSchema = z.enum([
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
  'REJECTED',
]);

/** ISO 639-1 code, e.g. "en", "kn". */
const LanguageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2}$/);
const ShortTextList = (max: number) =>
  z
    .array(z.string().trim().min(1).max(40))
    .max(max)
    .transform((items) => [...new Set(items)]);

// ── Profile ─────────────────────────────────────────────────────────────────

export const VerificationSchema = z.object({ email: z.boolean(), phone: z.boolean() });

export const MotorcycleSchema = z.object({
  id: z.uuid(),
  make: z.string(),
  model: z.string(),
  year: z.number().int().nullable(),
  engineCc: z.number().int().nullable(),
  category: MotorcycleCategorySchema,
  nickname: z.string().nullable(),
  isPrimary: z.boolean(),
  verificationStatus: VehicleVerificationStatusSchema,
});
export type Motorcycle = z.infer<typeof MotorcycleSchema>;

/** The signed-in member's own profile, including private contact details. */
export const PrivateProfileSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  bio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  homeCity: z.string().nullable(),
  country: z.string(),
  languages: z.array(z.string()),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  verification: VerificationSchema,
  hasPassword: z.boolean(),
  role: UserRoleSchema,
  status: UserStatusSchema,
  createdAt: z.string(),
});
export type PrivateProfile = z.infer<typeof PrivateProfileSchema>;

/** What other members see. `limited` profiles (private, or followers-only) show the basics. */
export const PublicProfileSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  limited: z.boolean(),
  bio: z.string().nullable(),
  homeCity: z.string().nullable(),
  country: z.string().nullable(),
  languages: z.array(z.string()),
  interests: z.array(z.string()),
  travelStyles: z.array(TravelStyleSchema),
  ridingExperience: RidingExperienceSchema.nullable(),
  verification: VerificationSchema,
  motorcycles: z.array(MotorcycleSchema.omit({ nickname: true })),
  memberSince: z.string(),
  follow: FollowStateSchema,
  /** Whether you may send this member a direct message (their message setting and blocks). */
  canMessage: z.boolean(),
});
export type PublicProfile = z.infer<typeof PublicProfileSchema>;

export const UpdateProfileSchema = z
  .object({
    username: UsernameSchema,
    displayName: DisplayNameSchema,
    bio: z.string().trim().max(500).nullable(),
    /** City-level only; exact home locations are never collected. */
    homeCity: z.string().trim().min(1).max(80).nullable(),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'Use a 2-letter country code'),
    languages: z
      .array(LanguageSchema)
      .max(10)
      .transform((items) => [...new Set(items)]),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type UpdateProfileInput = z.input<typeof UpdateProfileSchema>;

// ── Preferences ─────────────────────────────────────────────────────────────

export const PreferencesSchema = z.object({
  preferredMode: TripModeSchema.nullable(),
  interests: z.array(z.string()),
  preferredActivities: z.array(ActivityTypeSchema),
  travelStyles: z.array(TravelStyleSchema),
  preferredDestinations: z.array(z.string()),
  budgetMinPaise: z.number().int().nullable(),
  budgetMaxPaise: z.number().int().nullable(),
  groupSizeMin: z.number().int().nullable(),
  groupSizeMax: z.number().int().nullable(),
  ridingExperience: RidingExperienceSchema.nullable(),
  profileVisibility: ProfileVisibilitySchema,
  allowMessagesFrom: MessagePermissionSchema,
  pushEnabled: z.boolean(),
  emailEnabled: z.boolean(),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

const MAX_BUDGET_PAISE = 100_000_000; // ₹10,00,000
const GroupSize = z.number().int().min(1).max(500).nullable();
const Budget = z.number().int().min(0).max(MAX_BUDGET_PAISE).nullable();

export const UpdatePreferencesSchema = z
  .object({
    preferredMode: TripModeSchema.nullable(),
    interests: ShortTextList(30),
    preferredActivities: z
      .array(ActivityTypeSchema)
      .max(ActivityTypeSchema.options.length)
      .transform((items) => [...new Set(items)]),
    travelStyles: z
      .array(TravelStyleSchema)
      .max(TravelStyleSchema.options.length)
      .transform((items) => [...new Set(items)]),
    preferredDestinations: ShortTextList(30),
    budgetMinPaise: Budget,
    budgetMaxPaise: Budget,
    groupSizeMin: GroupSize,
    groupSizeMax: GroupSize,
    ridingExperience: RidingExperienceSchema.nullable(),
    profileVisibility: ProfileVisibilitySchema,
    allowMessagesFrom: MessagePermissionSchema,
    pushEnabled: z.boolean(),
    emailEnabled: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update')
  .refine(
    (v) =>
      v.budgetMinPaise == null || v.budgetMaxPaise == null || v.budgetMinPaise <= v.budgetMaxPaise,
    { message: 'Minimum budget must not exceed maximum', path: ['budgetMinPaise'] },
  )
  .refine(
    (v) => v.groupSizeMin == null || v.groupSizeMax == null || v.groupSizeMin <= v.groupSizeMax,
    { message: 'Minimum group size must not exceed maximum', path: ['groupSizeMin'] },
  );
export type UpdatePreferencesInput = z.input<typeof UpdatePreferencesSchema>;

// ── Motorcycles ─────────────────────────────────────────────────────────────

/**
 * Registration numbers, VINs and documents are deliberately not part of this contract:
 * vehicle identifiers are never collected through the profile or shown publicly.
 */
export const MotorcycleInputSchema = z.object({
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(80),
  year: z.number().int().min(1900).max(2100).nullable().optional(),
  engineCc: z.number().int().min(50).max(3000).nullable().optional(),
  category: MotorcycleCategorySchema,
  nickname: z.string().trim().min(1).max(60).nullable().optional(),
  isPrimary: z.boolean().optional(),
});
export type MotorcycleInput = z.input<typeof MotorcycleInputSchema>;

export const UpdateMotorcycleSchema = MotorcycleInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'Provide at least one field to update',
);

export const MAX_MOTORCYCLES_PER_USER = 10;
