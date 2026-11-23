import { z } from 'zod';
import { RefundTierSchema, RefundTiersSchema } from './bookings.js';
import { EmailSchema, PhoneSchema } from './auth.js';
import { GeoPointSchema } from './geo.js';
import { OperatorDocumentIdSchema, PackagePhotoIdSchema } from './maps-media.js';
import { CursorPageQuerySchema } from './pagination.js';
import { TripModeSchema } from './trip-mode.js';
import { ActivityTypeSchema } from './users.js';

/**
 * The commercial marketplace: verified operators sell paid experiences (packages). It is kept
 * apart from free community trips, where members only share their own costs. Packages are
 * guided experiences; Voyago does not sell passenger transport or match drivers.
 */

// ── Operators ───────────────────────────────────────────────────────────────

export const OperatorCategorySchema = z.enum([
  'TOUR_OPERATOR',
  'GUIDED_RIDES',
  'TREKKING',
  'ADVENTURE_ACTIVITIES',
  'CAMPING_AND_STAYS',
  'OTHER',
]);
export type OperatorCategory = z.infer<typeof OperatorCategorySchema>;

/** The operator terms the owner accepts when creating the business profile. */
export const OPERATOR_TERMS_VERSION = '2026-11';
export const MAX_OPERATOR_DOCUMENTS = 10;

/** 15-character Indian GST identification number. */
export const GstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN');

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

export const OperatorAddressSchema = z.object({
  line1: text(3, 200),
  line2: optionalText(200),
  city: text(2, 80),
  state: text(2, 80),
  postalCode: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{5}$/, 'Enter a 6-digit PIN code'),
});
export type OperatorAddress = z.infer<typeof OperatorAddressSchema>;

const operatorFields = {
  displayName: text(2, 120),
  legalName: text(2, 200),
  category: OperatorCategorySchema,
  description: optionalText(2000),
  businessEmail: EmailSchema.optional(),
  businessPhone: PhoneSchema.optional(),
  website: z
    .url({ protocol: /^https$/, error: 'Enter a https:// address' })
    .max(200)
    .optional(),
  gstin: GstinSchema.optional(),
  address: OperatorAddressSchema,
};

export const CreateOperatorSchema = z
  .object({
    ...operatorFields,
    /** The owner has read and accepts the operator terms (OPERATOR_TERMS_VERSION). */
    acceptTerms: z.literal(true, 'Accept the operator terms to continue'),
  })
  .refine((o) => o.businessEmail || o.businessPhone, {
    path: ['businessEmail'],
    message: 'Give a business email or phone number',
  });
export type CreateOperatorInput = z.input<typeof CreateOperatorSchema>;

export const UpdateOperatorSchema = z
  .object(operatorFields)
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Change at least one field');
export type UpdateOperatorInput = z.input<typeof UpdateOperatorSchema>;

export const OperatorVerificationStateSchema = z.enum([
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
]);

/** A document as its owner sees it (reviewer names stay with staff). */
export const OwnOperatorDocumentSchema = z.object({
  id: z.uuid(),
  kind: z.enum([
    'BUSINESS_REGISTRATION',
    'GST_CERTIFICATE',
    'OWNER_ID',
    'INSURANCE',
    'TOURISM_LICENCE',
    'OTHER',
  ]),
  fileName: z.string(),
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED']),
  reviewNote: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  uploadedAt: z.string(),
});
export type OwnOperatorDocument = z.infer<typeof OwnOperatorDocumentSchema>;

export const AddOperatorDocumentSchema = z.object({
  kind: OwnOperatorDocumentSchema.shape.kind,
  documentId: OperatorDocumentIdSchema,
  fileName: text(1, 200),
});
export type AddOperatorDocumentInput = z.input<typeof AddOperatorDocumentSchema>;

/** The owner's view of their business: everything they entered, status, and what's missing. */
export const MyOperatorSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  displayName: z.string(),
  legalName: z.string(),
  category: OperatorCategorySchema,
  description: z.string().nullable(),
  businessEmail: z.string().nullable(),
  businessPhone: z.string().nullable(),
  website: z.string().nullable(),
  gstin: z.string().nullable(),
  address: OperatorAddressSchema.extend({ line2: z.string().nullable() }).nullable(),
  verificationStatus: OperatorVerificationStateSchema,
  /** Staff's latest note on the verification decision. */
  verificationNote: z.string().nullable(),
  submittedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  termsAcceptedAt: z.string().nullable(),
  termsVersion: z.string().nullable(),
  documents: z.array(OwnOperatorDocumentSchema),
  /** What is still needed before submitting for review (empty when ready). */
  missing: z.array(z.string()),
  /** Waiting for staff: submitted and not yet decided. */
  inReview: z.boolean(),
  canSubmit: z.boolean(),
  /** Only verified operators can publish packages. */
  canPublish: z.boolean(),
});
export type MyOperator = z.infer<typeof MyOperatorSchema>;

// ── Packages ────────────────────────────────────────────────────────────────

export const PackageStatusSchema = z.enum([
  'DRAFT',
  'PENDING_REVIEW',
  'PUBLISHED',
  'SUSPENDED',
  'ARCHIVED',
]);
export type PackageStatus = z.infer<typeof PackageStatusSchema>;

/** ₹1 to ₹10,00,000 per person, in paise. */
export const MIN_PACKAGE_PRICE_PAISE = 100;
export const MAX_PACKAGE_PRICE_PAISE = 100_000_000;
export const MAX_PACKAGE_CAPACITY = 200;
export const MAX_PACKAGE_DAYS = 60;
export const MAX_PACKAGE_PHOTOS = 8;

export const PackagePriceSchema = z
  .number()
  .int('Price is in paise: a whole number')
  .min(MIN_PACKAGE_PRICE_PAISE, 'Price must be at least ₹1')
  .max(MAX_PACKAGE_PRICE_PAISE, 'Price can be at most ₹10,00,000 per person');

const PlaceSchema = z.object({ name: text(2, 160), point: GeoPointSchema });
const TermListSchema = z.array(text(2, 200)).max(30);

const packageFields = {
  mode: TripModeSchema,
  activityType: ActivityTypeSchema,
  title: text(5, 120),
  description: optionalText(5000),
  destination: PlaceSchema,
  /** Where the group meets on day one. Shown approximately until a booking is confirmed. */
  meetingPoint: PlaceSchema,
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  /** Total price per person, in paise, including taxes. */
  pricePaise: PackagePriceSchema,
  currency: z.literal('INR').default('INR'),
  capacity: z.number().int().min(1).max(MAX_PACKAGE_CAPACITY),
  inclusions: TermListSchema.min(1, 'List at least one thing that is included'),
  exclusions: TermListSchema.default([]),
  cancellationPolicy: text(20, 2000),
  /** The refunds customers get, by how early they cancel; required before publishing. */
  refundTiers: RefundTiersSchema.default([]),
  photoIds: z.array(PackagePhotoIdSchema).max(MAX_PACKAGE_PHOTOS).default([]),
};

type PackageRuleInput = {
  mode?: z.infer<typeof TripModeSchema>;
  activityType?: z.infer<typeof ActivityTypeSchema>;
  startsAt?: string;
  endsAt?: string;
};

/** Rules across fields, shared by the API (on the merged result of an update) and the app. */
export function packageRuleIssues(
  pkg: PackageRuleInput,
  now = Date.now(),
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (
    pkg.mode &&
    pkg.activityType &&
    (pkg.mode === 'RIDE') !== (pkg.activityType === 'MOTORCYCLE_RIDE')
  ) {
    issues.push({
      path: 'activityType',
      message: 'Rides are motorcycle rides; travel uses the other activities',
    });
  }
  if (pkg.startsAt && pkg.endsAt) {
    const start = Date.parse(pkg.startsAt);
    const end = Date.parse(pkg.endsAt);
    if (end < start) issues.push({ path: 'endsAt', message: 'Ends before it starts' });
    else if (end - start > MAX_PACKAGE_DAYS * 86_400_000) {
      issues.push({
        path: 'endsAt',
        message: `A package can last at most ${MAX_PACKAGE_DAYS} days`,
      });
    }
  }
  if (pkg.startsAt && Date.parse(pkg.startsAt) <= now) {
    issues.push({ path: 'startsAt', message: 'Choose a start in the future' });
  }
  return issues;
}

export const CreatePackageSchema = z.object(packageFields).superRefine((pkg, ctx) => {
  for (const issue of packageRuleIssues(pkg)) {
    ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  }
});
export type CreatePackageInput = z.input<typeof CreatePackageSchema>;

export const UpdatePackageSchema = z
  .object({
    ...packageFields,
    currency: z.literal('INR').optional(),
    exclusions: TermListSchema.optional(),
    refundTiers: RefundTiersSchema.optional(),
    photoIds: z.array(PackagePhotoIdSchema).max(MAX_PACKAGE_PHOTOS).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Change at least one field');
export type UpdatePackageInput = z.input<typeof UpdatePackageSchema>;

export const PackageOperatorSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  category: OperatorCategorySchema,
  verified: z.boolean(),
});

/** A listing in search results. Always marked commercial. */
export const PackageCardSchema = z.object({
  id: z.uuid(),
  /** Paid experience sold by a business, not a free community trip. */
  commercial: z.literal(true),
  title: z.string(),
  mode: TripModeSchema,
  activityType: ActivityTypeSchema,
  destinationName: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  durationDays: z.number().int(),
  /** Total per person, including taxes. */
  pricePaise: z.number().int(),
  currency: z.string(),
  capacity: z.number().int(),
  seatsLeft: z.number().int(),
  coverImageUrl: z.string().nullable(),
  operator: PackageOperatorSchema,
});
export type PackageCard = z.infer<typeof PackageCardSchema>;

export const PackageDetailSchema = PackageCardSchema.extend({
  status: PackageStatusSchema,
  description: z.string().nullable(),
  destination: z.object({ name: z.string(), point: GeoPointSchema.nullable() }),
  meetingPoint: z.object({
    name: z.string(),
    point: GeoPointSchema.nullable(),
    /** True when the point is rounded to about 1 km (everyone but the operator, for now). */
    approximate: z.boolean(),
  }),
  inclusions: z.array(z.string()),
  exclusions: z.array(z.string()),
  cancellationPolicy: z.string(),
  /** Refunds by how early the customer cancels, applied automatically. */
  refundTiers: z.array(RefundTierSchema),
  imageUrls: z.array(z.string()),
  /** On sale, places left, and payments set up on the server. */
  bookingOpen: z.boolean(),
  /** Why booking is closed, when it is. */
  bookingClosedReason: z.string().nullable(),
  viewer: z.object({
    isOperator: z.boolean(),
    canAsk: z.boolean(),
    /** The viewer's current booking (pending or confirmed), if any. */
    bookingId: z.uuid().nullable(),
  }),
});
export type PackageDetail = z.infer<typeof PackageDetailSchema>;

/** The operator's own view of a package, with what only they see. */
export const OwnPackageSchema = PackageDetailSchema.extend({
  photoIds: z.array(z.string()),
  suspendedReason: z.string().nullable(),
  viewCount: z.number().int(),
  publishedAt: z.string().nullable(),
  questions: z.object({ unanswered: z.number().int(), total: z.number().int() }),
  /** What must be fixed before it can be published (empty when ready). */
  publishIssues: z.array(z.string()),
  actions: z.array(z.enum(['edit', 'publish', 'unpublish', 'archive'])),
});
export type OwnPackage = z.infer<typeof OwnPackageSchema>;

export const PackagesQuerySchema = CursorPageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  mode: TripModeSchema.optional(),
  activityType: ActivityTypeSchema.optional(),
  operator: z.string().trim().max(80).optional(),
});
export type PackagesQuery = z.input<typeof PackagesQuerySchema>;

export const PublicOperatorSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  category: OperatorCategorySchema,
  description: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  website: z.string().nullable(),
  verified: z.boolean(),
  verifiedSince: z.string().nullable(),
  packages: z.array(PackageCardSchema),
});
export type PublicOperator = z.infer<typeof PublicOperatorSchema>;

// ── Questions ───────────────────────────────────────────────────────────────

export const AskQuestionSchema = z.object({ question: text(5, 500) });
export const AnswerQuestionSchema = z.object({ answer: text(1, 1000) });

export const PackageQuestionSchema = z.object({
  id: z.uuid(),
  packageId: z.uuid(),
  question: z.string(),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
  createdAt: z.string(),
  /** Who asked: shown to the operator; others see only their own questions marked as theirs. */
  asker: z.object({ username: z.string(), displayName: z.string() }).nullable(),
  mine: z.boolean(),
  hidden: z.boolean(),
});
export type PackageQuestion = z.infer<typeof PackageQuestionSchema>;

export const OperatorQuestionsQuerySchema = CursorPageQuerySchema.extend({
  unanswered: z.enum(['true', 'false']).optional(),
});

// ── Dashboard ───────────────────────────────────────────────────────────────

export const OperatorDashboardSchema = z.object({
  operator: z.object({
    displayName: z.string(),
    slug: z.string(),
    verificationStatus: OperatorVerificationStateSchema,
    verificationNote: z.string().nullable(),
    inReview: z.boolean(),
    canPublish: z.boolean(),
  }),
  packages: z.object({
    draft: z.number().int(),
    published: z.number().int(),
    upcoming: z.number().int(),
    suspended: z.number().int(),
    archived: z.number().int(),
  }),
  /** Read-only until bookings open (payments milestone). */
  bookings: z.object({
    total: z.number().int(),
    confirmed: z.number().int(),
    seats: z.number().int(),
  }),
  questions: z.object({ unanswered: z.number().int(), answered: z.number().int() }),
  performance: z.object({
    listingViews: z.number().int(),
    /** Share of questions answered, 0–100, or null with no questions yet. */
    answerRatePercent: z.number().int().nullable(),
  }),
});
export type OperatorDashboard = z.infer<typeof OperatorDashboardSchema>;

/** "₹3,499" or "₹3,499.50" from paise. */
export function formatPaise(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}
