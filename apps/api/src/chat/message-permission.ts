import { type PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';
import { isBlockedEitherWay } from '../social/blocks.js';

type Client = PrismaService | Prisma.TransactionClient;

/**
 * Whether `senderId` may send `recipientId` a direct message, by the recipient's "who can message
 * me" setting (default: people I share a trip with):
 * - EVERYONE, NOBODY: as named.
 * - FOLLOWERS: the sender follows the recipient.
 * - TRIP_PARTICIPANTS: both are (or were) on the same trip.
 * Blocks, in either direction, always close the chat. Once the recipient has written in the chat
 * the sender may reply, unless the recipient has since chosen NOBODY.
 */
export async function directMessageAllowed(
  client: Client,
  senderId: string,
  recipientId: string,
  conversationId?: string,
): Promise<boolean> {
  if (senderId === recipientId) return false;
  const recipient = await client.user.findUnique({
    where: { id: recipientId },
    select: { status: true, deletedAt: true, preferences: { select: { allowMessagesFrom: true } } },
  });
  if (!recipient || recipient.status !== 'ACTIVE' || recipient.deletedAt) return false;
  if (await isBlockedEitherWay(client, senderId, recipientId)) return false;

  const setting = recipient.preferences?.allowMessagesFrom ?? 'TRIP_PARTICIPANTS';
  if (setting === 'NOBODY') return false;
  if (setting === 'EVERYONE') return true;
  if (conversationId) {
    const replied = await client.message.findFirst({
      where: { conversationId, senderId: recipientId, deletedAt: null },
      select: { id: true },
    });
    if (replied) return true;
  }
  if (setting === 'FOLLOWERS') {
    const follow = await client.follow.findUnique({
      where: { followerId_followeeId: { followerId: senderId, followeeId: recipientId } },
      select: { followerId: true },
    });
    return follow !== null;
  }
  const shared = await client.tripParticipant.findFirst({
    where: {
      userId: senderId,
      status: { in: ['ACTIVE', 'COMPLETED'] },
      trip: {
        deletedAt: null,
        participants: {
          some: { userId: recipientId, status: { in: ['ACTIVE', 'COMPLETED'] } },
        },
      },
    },
    select: { tripId: true },
  });
  return shared !== null;
}
