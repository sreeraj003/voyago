import { z } from 'zod';
import { PageInfoSchema } from './pagination.js';
import { type ReportReason, ReportReasonSchema, ReportTargetTypeSchema } from './social.js';
import { type UserRole, UserRoleSchema, UserStatusSchema } from './users.js';

/**
 * Admin dashboard and moderation contracts.
 *
 * Every admin route is checked on the server against PERMISSIONS_BY_ROLE. The admin app uses the
 * same table only to hide buttons a role cannot use; hiding a button is never the authorization.
 */

export const StaffRoleSchema = z.enum(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'OPERATIONS']);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

export const ADMIN_PERMISSIONS = [
  /** Dashboard metrics and the signed-in staff member's own profile. */
  'dashboard.view',
  /** Search members and see status, verification and moderation history. */
  'users.read',
  /** Suspend and restore members. */
  'users.suspend',
  /** Grant and remove staff roles. */
  'users.role',
  'trips.read',
  /** Hide, unhide and cancel trips; remove posts and chat messages. */
  'content.moderate',
  'reports.read',
  /** Assign, triage and resolve reports. */
  'reports.manage',
  'operators.read',
  /** Accept or reject documents and set an operator's verification status. */
  'operators.verify',
  /** Open operator documents (short-lived links; every view is audited). */
  'operators.documents',
  'audit.read',
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];
export const AdminPermissionSchema = z.enum(ADMIN_PERMISSIONS);

export const PERMISSIONS_BY_ROLE: Record<StaffRole, readonly AdminPermission[]> = {
  SUPER_ADMIN: ADMIN_PERMISSIONS,
  MODERATOR: [
    'dashboard.view',
    'users.read',
    'users.suspend',
    'trips.read',
    'content.moderate',
    'reports.read',
    'reports.manage',
  ],
  SUPPORT: ['dashboard.view', 'users.read', 'trips.read', 'reports.read'],
  OPERATIONS: [
    'dashboard.view',
    'users.read',
    'trips.read',
    'operators.read',
    'operators.verify',
    'operators.documents',
  ],
};

export const isStaffRole = (role: UserRole): role is StaffRole => role !== 'USER';

export function permissionsFor(role: UserRole): readonly AdminPermission[] {
  return isStaffRole(role) ? PERMISSIONS_BY_ROLE[role] : [];
}

export function hasPermission(role: UserRole, permission: AdminPermission): boolean {
  return permissionsFor(role).includes(permission);
}

/** A reason recorded in the audit log for every privileged action. */
export const ModerationReasonSchema = z
  .string()
  .trim()
  .min(5, 'Give a reason of at least 5 characters')
  .max(500);
export const ReasonBodySchema = z.object({ reason: ModerationReasonSchema });
export type ReasonBody = z.input<typeof ReasonBodySchema>;

const adminPageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/, 'Invalid cursor')
    .optional(),
};
const optionalSearch = z.string().trim().max(100).optional();

export const StaffPersonSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  role: UserRoleSchema,
});
export type StaffPerson = z.infer<typeof StaffPersonSchema>;

export const AdminMeSchema = StaffPersonSchema.extend({
  role: StaffRoleSchema,
  permissions: z.array(AdminPermissionSchema),
});
export type AdminMe = z.infer<typeof AdminMeSchema>;

// ── Dashboard ───────────────────────────────────────────────────────────────

export const DashboardSchema = z.object({
  generatedAt: z.string(),
  users: z.object({
    total: z.number().int(),
    registeredLast7Days: z.number().int(),
    registeredLast30Days: z.number().int(),
    /** Members who signed in or refreshed a session in the window. */
    activeLast7Days: z.number().int(),
    activeLast30Days: z.number().int(),
    suspended: z.number().int(),
  }),
  trips: z.object({
    createdLast30Days: z.number().int(),
    completedLast30Days: z.number().int(),
    /** Published or full, departing in the future. */
    upcoming: z.number().int(),
    hidden: z.number().int(),
  }),
  reports: z.object({
    open: z.number().int(),
    inReview: z.number().int(),
    /** Open or in review, HIGH or CRITICAL. */
    urgent: z.number().int(),
  }),
  operators: z.object({ pendingVerification: z.number().int() }),
  /** Bookings and payments arrive in a later milestone; null until then. */
  bookings: z.null(),
  /** Day-by-day sign-ups and trips created for the last 14 days (UTC dates). */
  daily: z.array(
    z.object({ date: z.string(), registrations: z.number().int(), tripsCreated: z.number().int() }),
  ),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

// ── Audit ───────────────────────────────────────────────────────────────────

export const AuditEntrySchema = z.object({
  id: z.uuid(),
  actor: StaffPersonSchema.nullable(),
  actorType: z.enum(['USER', 'ADMIN', 'SYSTEM']),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  reason: z.string().nullable(),
  /** Before/after values. Never secrets, contact details or document contents. */
  metadata: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditQuerySchema = z.object({
  ...adminPageQuery,
  action: z
    .string()
    .trim()
    .regex(/^[a-z_.]{1,100}$/)
    .optional(),
  actorId: z.uuid().optional(),
  entityType: z
    .string()
    .trim()
    .regex(/^[a-z_]{1,60}$/)
    .optional(),
  entityId: z.uuid().optional(),
});
export type AuditQuery = z.input<typeof AuditQuerySchema>;

export const AuditPageSchema = z.object({ data: z.array(AuditEntrySchema), page: PageInfoSchema });

// ── Users ───────────────────────────────────────────────────────────────────

export const AdminUserSummarySchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  role: UserRoleSchema,
  status: UserStatusSchema,
  homeCity: z.string().nullable(),
  /** Masked, e.g. "a***@example.com". Full contact details are never shown in the admin app. */
  maskedEmail: z.string().nullable(),
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  openReportsAgainst: z.number().int(),
  createdAt: z.string(),
  lastActiveAt: z.string().nullable(),
  deleted: z.boolean(),
});
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>;

export const AdminUsersQuerySchema = z.object({
  ...adminPageQuery,
  /** Username, display name or exact email. */
  q: optionalSearch,
  status: UserStatusSchema.optional(),
  role: UserRoleSchema.optional(),
});
export type AdminUsersQuery = z.input<typeof AdminUsersQuerySchema>;
export const AdminUserPageSchema = z.object({
  data: z.array(AdminUserSummarySchema),
  page: PageInfoSchema,
});

export const ReportSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type ReportSeverity = z.infer<typeof ReportSeveritySchema>;
export const ReportStatusSchema = z.enum(['OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED']);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

/** Starting severity of a new report; moderators can change it. */
export function defaultReportSeverity(reason: ReportReason): ReportSeverity {
  switch (reason) {
    case 'UNSAFE_BEHAVIOUR':
    case 'SCAM_OR_FRAUD':
    case 'ILLEGAL_TRANSPORT':
      return 'HIGH';
    case 'HARASSMENT':
    case 'FAKE_PROFILE':
    case 'INAPPROPRIATE_CONTENT':
      return 'MEDIUM';
    case 'SPAM':
    case 'OTHER':
      return 'LOW';
  }
}

export const AdminReportSummarySchema = z.object({
  id: z.uuid(),
  targetType: ReportTargetTypeSchema.or(z.enum(['REVIEW', 'COMMERCIAL_PACKAGE'])),
  targetId: z.uuid(),
  /** Short description of the reported thing, e.g. the trip title or "@username". */
  targetLabel: z.string(),
  reason: ReportReasonSchema,
  severity: ReportSeveritySchema,
  status: ReportStatusSchema,
  reporter: StaffPersonSchema.nullable(),
  reportedUser: StaffPersonSchema.nullable(),
  assignedTo: StaffPersonSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminReportSummary = z.infer<typeof AdminReportSummarySchema>;

export const AdminUserDetailSchema = AdminUserSummarySchema.extend({
  bio: z.string().nullable(),
  maskedPhone: z.string().nullable(),
  /** The latest suspension's reason, while suspended. */
  suspension: z.object({ reason: z.string().nullable(), at: z.string() }).nullable(),
  counts: z.object({
    tripsOrganised: z.number().int(),
    reportsAgainst: z.number().int(),
    reportsFiled: z.number().int(),
  }),
  motorcycles: z.array(
    z.object({
      id: z.uuid(),
      label: z.string(),
      verificationStatus: z.enum(['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED']),
    }),
  ),
  operator: z
    .object({
      id: z.uuid(),
      displayName: z.string(),
      verificationStatus: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED']),
    })
    .nullable(),
  reportsAgainst: z.array(AdminReportSummarySchema),
  history: z.array(AuditEntrySchema),
  /** What the signed-in staff member may do to this account. */
  actions: z.array(z.enum(['suspend', 'restore', 'role'])),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

export const SetRoleSchema = z.object({ role: UserRoleSchema, reason: ModerationReasonSchema });
export type SetRoleInput = z.input<typeof SetRoleSchema>;

// ── Trips ───────────────────────────────────────────────────────────────────

const TripStatusValues = z.enum([
  'DRAFT',
  'PUBLISHED',
  'FULL',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
]);

export const AdminTripSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  mode: z.enum(['RIDE', 'TRAVEL']),
  status: TripStatusValues,
  visibility: z.enum(['PUBLIC', 'FOLLOWERS', 'COMMUNITY', 'PRIVATE']),
  originName: z.string(),
  destinationName: z.string(),
  departureAt: z.string(),
  organiser: StaffPersonSchema,
  hidden: z.boolean(),
  openReports: z.number().int(),
  createdAt: z.string(),
});
export type AdminTripSummary = z.infer<typeof AdminTripSummarySchema>;

export const AdminTripsQuerySchema = z.object({
  ...adminPageQuery,
  /** Title, place name or exact trip id. */
  q: optionalSearch,
  status: TripStatusValues.optional(),
  hidden: z.enum(['true', 'false']).optional(),
  reported: z.enum(['true']).optional(),
});
export type AdminTripsQuery = z.input<typeof AdminTripsQuerySchema>;
export const AdminTripPageSchema = z.object({
  data: z.array(AdminTripSummarySchema),
  page: PageInfoSchema,
});

export const AdminTripDetailSchema = AdminTripSummarySchema.extend({
  description: z.string().nullable(),
  maxParticipants: z.number().int(),
  participantCount: z.number().int(),
  hiddenReason: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  reports: z.array(AdminReportSummarySchema),
  history: z.array(AuditEntrySchema),
  actions: z.array(z.enum(['hide', 'unhide', 'cancel'])),
});
export type AdminTripDetail = z.infer<typeof AdminTripDetailSchema>;

// ── Reports ─────────────────────────────────────────────────────────────────

export const AdminReportsQuerySchema = z.object({
  ...adminPageQuery,
  /** Defaults to the open queue (OPEN and IN_REVIEW). */
  status: z.enum(['QUEUE', 'OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED', 'ALL']).default('QUEUE'),
  severity: ReportSeveritySchema.optional(),
  targetType: ReportTargetTypeSchema.optional(),
  assigned: z.enum(['me', 'unassigned']).optional(),
});
export type AdminReportsQuery = z.input<typeof AdminReportsQuerySchema>;
export const AdminReportPageSchema = z.object({
  data: z.array(AdminReportSummarySchema),
  page: PageInfoSchema,
});

/** What was reported, as moderators see it now (the content may have changed since). */
export const ReportTargetSnapshotSchema = z.object({
  exists: z.boolean(),
  /** Text of a post or message, a trip's description, or a profile bio. */
  text: z.string().nullable(),
  /** Trip or community status, or the account status. */
  status: z.string().nullable(),
  removed: z.boolean(),
  /** Where the content lives, e.g. "Trip chat: Nandi Hills sunrise". */
  context: z.string().nullable(),
});
export type ReportTargetSnapshot = z.infer<typeof ReportTargetSnapshotSchema>;

export const AdminReportDetailSchema = AdminReportSummarySchema.extend({
  details: z.string().nullable(),
  /** Moderator-added references: links, message ids, ticket numbers. */
  evidenceRefs: z.array(z.string()),
  resolutionNote: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  target: ReportTargetSnapshotSchema,
  /** Other reports of the same thing, newest first. */
  related: z.array(AdminReportSummarySchema),
  history: z.array(AuditEntrySchema),
  actions: z.array(
    z.enum([
      'assign',
      'triage',
      'resolve',
      'reopen',
      'suspend_user',
      'hide_trip',
      'cancel_trip',
      'remove_post',
      'remove_message',
    ]),
  ),
});
export type AdminReportDetail = z.infer<typeof AdminReportDetailSchema>;

export const AssignReportSchema = z.object({
  /** A staff member who can manage reports, or null to unassign. */
  assigneeId: z.uuid().nullable(),
});
export type AssignReportInput = z.input<typeof AssignReportSchema>;

export const EvidenceRefSchema = z.string().trim().min(1).max(500);
export const TriageReportSchema = z
  .object({
    severity: ReportSeveritySchema.optional(),
    evidenceRefs: z.array(EvidenceRefSchema).max(20).optional(),
  })
  .refine((v) => v.severity !== undefined || v.evidenceRefs !== undefined, {
    message: 'Change the severity or the evidence',
  });
export type TriageReportInput = z.input<typeof TriageReportSchema>;

export const ResolveReportSchema = z.object({
  outcome: z.enum(['ACTIONED', 'DISMISSED']),
  note: z.string().trim().min(5, 'Write a resolution note').max(2000),
});
export type ResolveReportInput = z.input<typeof ResolveReportSchema>;

// ── Operators ───────────────────────────────────────────────────────────────

export const OperatorVerificationStatusSchema = z.enum([
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
]);
export const OperatorDocumentKindSchema = z.enum([
  'BUSINESS_REGISTRATION',
  'GST_CERTIFICATE',
  'OWNER_ID',
  'INSURANCE',
  'TOURISM_LICENCE',
  'OTHER',
]);
export const OperatorDocumentStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'REJECTED']);

export const AdminOperatorSummarySchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  legalName: z.string(),
  slug: z.string(),
  owner: StaffPersonSchema,
  verificationStatus: OperatorVerificationStatusSchema,
  submittedAt: z.string().nullable(),
  documentCount: z.number().int(),
  pendingDocumentCount: z.number().int(),
  createdAt: z.string(),
});
export type AdminOperatorSummary = z.infer<typeof AdminOperatorSummarySchema>;

export const AdminOperatorsQuerySchema = z.object({
  ...adminPageQuery,
  status: OperatorVerificationStatusSchema.optional(),
  q: optionalSearch,
});
export type AdminOperatorsQuery = z.input<typeof AdminOperatorsQuerySchema>;
export const AdminOperatorPageSchema = z.object({
  data: z.array(AdminOperatorSummarySchema),
  page: PageInfoSchema,
});

/** Document metadata only. The file is opened through a short-lived, audited link. */
export const OperatorDocumentSchema = z.object({
  id: z.uuid(),
  kind: OperatorDocumentKindSchema,
  fileName: z.string(),
  status: OperatorDocumentStatusSchema,
  reviewNote: z.string().nullable(),
  reviewedBy: StaffPersonSchema.nullable(),
  reviewedAt: z.string().nullable(),
  uploadedAt: z.string(),
});
export type OperatorDocument = z.infer<typeof OperatorDocumentSchema>;

export const AdminOperatorDetailSchema = AdminOperatorSummarySchema.extend({
  /** Present only for staff who may open documents. */
  gstin: z.string().nullable(),
  verificationNote: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  verifiedBy: StaffPersonSchema.nullable(),
  documents: z.array(OperatorDocumentSchema),
  packages: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      status: z.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'SUSPENDED', 'ARCHIVED']),
      startsAt: z.string().nullable(),
      pricePaise: z.number().int(),
      suspendedReason: z.string().nullable(),
    }),
  ),
  history: z.array(AuditEntrySchema),
  actions: z.array(
    z.enum(['review_documents', 'open_documents', 'set_status', 'moderate_packages']),
  ),
});
export type AdminOperatorDetail = z.infer<typeof AdminOperatorDetailSchema>;

export const ReviewDocumentSchema = z.object({
  status: z.enum(['ACCEPTED', 'REJECTED']),
  note: z.string().trim().max(1000).optional(),
});
export type ReviewDocumentInput = z.input<typeof ReviewDocumentSchema>;

export const SetOperatorStatusSchema = z.object({
  status: z.enum(['VERIFIED', 'REJECTED', 'SUSPENDED']),
  reason: ModerationReasonSchema,
});
export type SetOperatorStatusInput = z.input<typeof SetOperatorStatusSchema>;

export const SuspendPackageSchema = z.object({ reason: ModerationReasonSchema });
export type SuspendPackageInput = z.input<typeof SuspendPackageSchema>;

export const DocumentLinkSchema = z.object({ url: z.string(), expiresAt: z.string() });
export type DocumentLink = z.infer<typeof DocumentLinkSchema>;

export const StaffListSchema = z.object({ data: z.array(StaffPersonSchema) });

/** Masks an email for staff screens: first character and the domain only. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** Masks a phone number: country code and last two digits only. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return `${phone.slice(0, 3)}******${phone.slice(-2)}`;
}
