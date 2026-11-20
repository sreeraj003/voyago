/**
 * Grants or removes a staff role from the command line. This is how the first SUPER_ADMIN is
 * created in a real environment (after that, super admins manage roles in the admin app).
 *
 * The account must already exist and be active. The change is recorded in the audit log as a
 * SYSTEM action with the reason given. Needs direct database access (DATABASE_URL), so only
 * people who operate the deployment can run it.
 *
 * Run: pnpm --filter @voyago/api admin:grant-role --email you@example.com --role SUPER_ADMIN \
 *        --reason "First administrator"
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { ModerationReasonSchema, UserRoleSchema } from '@voyago/shared';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/prisma/client.js';

const Args = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  role: UserRoleSchema,
  reason: ModerationReasonSchema,
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      role: { type: 'string' },
      reason: { type: 'string' },
    },
  });
  const parsed = Args.safeParse(values);
  if (!parsed.success) {
    console.error(
      'Usage: admin:grant-role --email <email> --role <USER|SUPER_ADMIN|MODERATOR|SUPPORT|OPERATIONS> --reason "<why>"',
    );
    console.error(z.prettifyError(parsed.error));
    process.exitCode = 1;
    return;
  }
  const { email, role, reason } = parsed.data;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { email, deletedAt: null },
        select: { id: true, role: true, status: true },
      });
      if (!user) throw new Error('No account with that email.');
      if (user.status !== 'ACTIVE') throw new Error('That account is not active.');
      if (user.role === role) throw new Error(`That account already has the ${role} role.`);
      await tx.user.update({ where: { id: user.id }, data: { role } });
      await tx.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: 'user.role_change',
          entityType: 'user',
          entityId: user.id,
          metadata: { from: user.role, to: role, reason, via: 'cli' },
        },
      });
      console.warn(`Role changed from ${user.role} to ${role}. Recorded in the audit log.`);
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
