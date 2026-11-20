import { z } from 'zod';
import { CursorPageQuerySchema } from './pagination.js';

/** Follows, blocks and reports. Blocking is always free and always available. */

export const FollowStateSchema = z.object({
  followerCount: z.number().int(),
  followingCount: z.number().int(),
  /** Viewer follows them. */
  isFollowing: z.boolean(),
  /** They follow the viewer. Only shown when their profile is visible to the viewer. */
  followsYou: z.boolean(),
  /** Both follow each other. */
  mutual: z.boolean(),
});
export type FollowState = z.infer<typeof FollowStateSchema>;

export const PersonSummarySchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
});
export type PersonSummary = z.infer<typeof PersonSummarySchema>;

export const ReportTargetTypeSchema = z.enum(['USER', 'TRIP', 'COMMUNITY', 'POST']);
export const ReportReasonSchema = z.enum([
  'HARASSMENT',
  'SPAM',
  'FAKE_PROFILE',
  'UNSAFE_BEHAVIOUR',
  'INAPPROPRIATE_CONTENT',
  'SCAM_OR_FRAUD',
  'ILLEGAL_TRANSPORT',
  'OTHER',
]);
export const CreateReportSchema = z.object({
  targetType: ReportTargetTypeSchema,
  targetId: z.uuid(),
  reason: ReportReasonSchema,
  details: z.string().trim().max(2000).optional(),
});
export type CreateReportInput = z.input<typeof CreateReportSchema>;
export const ReportReceiptSchema = z.object({
  id: z.uuid(),
  status: z.literal('OPEN'),
  createdAt: z.string(),
});

export const BlockedUserSchema = z.object({
  user: PersonSummarySchema,
  blockedAt: z.string(),
});
export type BlockedUser = z.infer<typeof BlockedUserSchema>;

export const ConnectionsQuerySchema = CursorPageQuerySchema;
export const ConnectionSchema = z.object({
  user: PersonSummarySchema,
  since: z.string(),
  /** The viewer follows this person. */
  isFollowing: z.boolean(),
});
export type Connection = z.infer<typeof ConnectionSchema>;
