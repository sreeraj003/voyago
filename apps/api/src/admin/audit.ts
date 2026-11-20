import { type AuditEntry } from '@voyago/shared';
import { type Prisma } from '../generated/prisma/client.js';
import { type Actor } from './permissions.js';
import { staffPerson, staffPersonSelect } from './people.js';

type Tx = Prisma.TransactionClient;

export interface AuditInput {
  /** Dotted verb, e.g. "user.suspend", "report.resolve". */
  action: string;
  entityType: string;
  entityId: string | null;
  reason?: string | null;
  /** Before/after values. Never secrets, contact details or document contents. */
  metadata?: Prisma.InputJsonObject;
}

/**
 * Records a privileged action. Called inside the same transaction as the change, so the change
 * and its audit row are committed together or not at all.
 */
export async function recordAudit(tx: Tx, actor: Actor, input: AuditInput): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: actor.user.id,
      actorType: 'ADMIN',
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: {
        ...(input.metadata ?? {}),
        ...(input.reason ? { reason: input.reason } : {}),
        role: actor.user.role,
      },
      requestId: actor.requestId,
    },
  });
}

export const auditSelect = {
  id: true,
  actorType: true,
  action: true,
  entityType: true,
  entityId: true,
  metadata: true,
  requestId: true,
  createdAt: true,
  actor: { select: staffPersonSelect },
} as const satisfies Prisma.AuditLogSelect;

type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof auditSelect }>;

export function toAuditEntry(row: AuditRow): AuditEntry {
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
  const reason = typeof metadata?.reason === 'string' ? metadata.reason : null;
  return {
    id: row.id,
    actor: row.actor ? staffPerson(row.actor) : null,
    actorType: row.actorType,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    reason,
    metadata,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}
