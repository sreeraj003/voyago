import { type PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';

type Client = PrismaService | Prisma.TransactionClient;

/** True when either person has blocked the other. */
export async function isBlockedEitherWay(client: Client, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const row = await client.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
    select: { blockerId: true },
  });
  return row !== null;
}

/** Everyone the user has blocked or been blocked by. Their content is hidden both ways. */
export async function blockedIds(client: Client, userId: string): Promise<string[]> {
  const rows = await client.userBlock.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  return [
    ...new Set(rows.map((row) => (row.blockerId === userId ? row.blockedId : row.blockerId))),
  ];
}
